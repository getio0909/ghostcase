import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { win32 } from 'node:path';
import type { Readable, Writable } from 'node:stream';

const HELPER_START_TIMEOUT_MILLISECONDS = 10_000;
const HELPER_REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const MAX_PROTOCOL_BUFFER_BYTES = 4_096;
const MAX_WINDOWS_PROCESS_ID = 4_294_967_295;
const WINDOWS_FILETIME_MAXIMUM = 9_223_372_036_854_775_807n;
const WINDOWS_FILETIME_TICKS_PER_MILLISECOND = 10_000n;
const WINDOWS_FILETIME_MILLISECOND_END_OFFSET = 9_999n;
const WINDOWS_TO_UNIX_EPOCH_FILETIME = 116_444_736_000_000_000n;
const MAX_WINDOWS_FILETIME_UNIX_MILLISECONDS = Number(
  (WINDOWS_FILETIME_MAXIMUM -
    WINDOWS_TO_UNIX_EPOCH_FILETIME -
    WINDOWS_FILETIME_MILLISECOND_END_OFFSET) /
    WINDOWS_FILETIME_TICKS_PER_MILLISECOND,
);

const WINDOWS_TREE_HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

public static class GhostCaseProcessTree
{
    private const uint TH32CS_SNAPPROCESS = 0x00000002;
    private const uint PROCESS_TERMINATE = 0x00000001;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x00001000;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint WAIT_OBJECT_0 = 0x00000000;
    private const int ERROR_NO_MORE_FILES = 18;
    private const int ERROR_INVALID_PARAMETER = 87;
    private const int MAX_DESCENDANTS = 1024;
    private const int NATURAL_EXIT_GRACE_MILLISECONDS = 250;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME
    {
        public uint Low;
        public uint High;
    }

    private sealed class SnapshotEntry
    {
        public uint Pid;
        public uint ParentPid;
        public int Depth;
        public long CreationFileTime;
    }

    private sealed class Candidate
    {
        public uint Pid;
        public int Depth;
        public long CreationFileTime;
        public IntPtr Handle;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32 entry);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentProcessId();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetProcessTimes(
        IntPtr process,
        out FILETIME creation,
        out FILETIME exit,
        out FILETIME kernel,
        out FILETIME user);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll")]
    private static extern void GetSystemTimePreciseAsFileTime(out FILETIME systemTime);

    public static void Run()
    {
        Console.Out.WriteLine("READY");
        Console.Out.Flush();
        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            var parts = line.Split(':');
            ulong requestId;
            ulong rootPid;
            ulong startedFileTime;
            ulong closedFileTime;
            if (parts.Length != 4 ||
                !TryParseUnsignedDecimal(parts[0], 10, out requestId) ||
                requestId > 9999999999UL ||
                !TryParseUnsignedDecimal(parts[1], 10, out rootPid) ||
                rootPid > uint.MaxValue ||
                !TryParseUnsignedDecimal(parts[2], 19, out startedFileTime) ||
                startedFileTime > long.MaxValue ||
                !TryParseUnsignedDecimal(parts[3], 19, out closedFileTime) ||
                closedFileTime > long.MaxValue)
            {
                Console.Out.WriteLine("FATAL");
                Console.Out.Flush();
                return;
            }

            string result;
            try
            {
                result = Cleanup(
                    (uint)rootPid,
                    (long)startedFileTime,
                    (long)closedFileTime);
            }
            catch
            {
                result = "FAILED:HELPER";
            }
            Console.Out.WriteLine(
                requestId.ToString(CultureInfo.InvariantCulture) + ":" + result);
            Console.Out.Flush();
        }
    }

    public static string Cleanup(uint rootPid, long startedFileTime, long closedFileTime)
    {
        FILETIME snapshotBoundary;
        GetSystemTimePreciseAsFileTime(out snapshotBoundary);
        var snapshotCreationUpperBound = ToLong(snapshotBoundary);
        var snapshotEntries = ReadSnapshot();
        var children = new Dictionary<uint, List<SnapshotEntry>>();
        var helperPid = GetCurrentProcessId();
        foreach (var entry in snapshotEntries)
        {
            if (entry.Pid == helperPid)
            {
                continue;
            }
            List<SnapshotEntry> siblings;
            if (!children.TryGetValue(entry.ParentPid, out siblings))
            {
                siblings = new List<SnapshotEntry>();
                children.Add(entry.ParentPid, siblings);
            }
            siblings.Add(entry);
        }

        var candidates = new List<Candidate>();
        var queue = new Queue<SnapshotEntry>();
        var seen = new HashSet<uint>();
        var identityFailed = false;
        seen.Add(rootPid);
        queue.Enqueue(new SnapshotEntry
        {
            Pid = rootPid,
            Depth = 0,
            CreationFileTime = startedFileTime
        });
        try
        {
            while (queue.Count > 0)
            {
                var parent = queue.Dequeue();
                List<SnapshotEntry> direct;
                if (!children.TryGetValue(parent.Pid, out direct))
                {
                    continue;
                }
                foreach (var child in direct)
                {
                    if (!seen.Add(child.Pid))
                    {
                        continue;
                    }

                    var handle = OpenProcess(
                        PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
                        false,
                        child.Pid);
                    if (handle == IntPtr.Zero)
                    {
                        if (Marshal.GetLastWin32Error() != ERROR_INVALID_PARAMETER)
                        {
                            identityFailed = true;
                        }
                        continue;
                    }

                    FILETIME creation;
                    FILETIME exit;
                    FILETIME kernel;
                    FILETIME user;
                    if (!GetProcessTimes(handle, out creation, out exit, out kernel, out user))
                    {
                        CloseHandle(handle);
                        identityFailed = true;
                        continue;
                    }
                    var created = ToLong(creation);
                    var latestAllowedCreation = parent.Depth == 0
                        ? Math.Min(closedFileTime, snapshotCreationUpperBound)
                        : snapshotCreationUpperBound;
                    if (created < parent.CreationFileTime || created > latestAllowedCreation)
                    {
                        CloseHandle(handle);
                        continue;
                    }

                    child.Depth = parent.Depth + 1;
                    child.CreationFileTime = created;
                    candidates.Add(new Candidate
                    {
                        Pid = child.Pid,
                        Depth = child.Depth,
                        CreationFileTime = created,
                        Handle = handle
                    });
                    if (candidates.Count > MAX_DESCENDANTS)
                    {
                        return "FAILED:DESCENDANT_LIMIT";
                    }
                    queue.Enqueue(child);
                }
            }

            if (candidates.Count == 0)
            {
                return identityFailed ? "FAILED:IDENTITY" : "NONE";
            }
            WaitForNaturalExit(candidates);

            candidates.Sort(delegate(Candidate left, Candidate right)
            {
                var depth = right.Depth.CompareTo(left.Depth);
                return depth != 0
                    ? depth
                    : right.CreationFileTime.CompareTo(left.CreationFileTime);
            });

            var terminationFailed = false;
            var terminatedCount = 0;
            foreach (var candidate in candidates)
            {
                if (WaitForSingleObject(candidate.Handle, 0) == WAIT_OBJECT_0)
                {
                    continue;
                }
                if (!TerminateProcess(candidate.Handle, 1))
                {
                    if (WaitForSingleObject(candidate.Handle, 1000) != WAIT_OBJECT_0)
                    {
                        terminationFailed = true;
                    }
                    continue;
                }
                terminatedCount++;
                if (WaitForSingleObject(candidate.Handle, 1000) != WAIT_OBJECT_0)
                {
                    terminationFailed = true;
                }
            }

            foreach (var candidate in candidates)
            {
                if (WaitForSingleObject(candidate.Handle, 0) != WAIT_OBJECT_0)
                {
                    terminationFailed = true;
                }
            }
            if (terminationFailed)
            {
                return "FAILED:TERMINATION";
            }
            if (identityFailed)
            {
                return "FAILED:IDENTITY";
            }
            return terminatedCount == 0
                ? "NONE"
                : "CONFIRMED:" + terminatedCount.ToString();
        }
        finally
        {
            foreach (var candidate in candidates)
            {
                if (candidate.Handle != IntPtr.Zero)
                {
                    CloseHandle(candidate.Handle);
                }
            }
        }
    }

    private static List<SnapshotEntry> ReadSnapshot()
    {
        var snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == new IntPtr(-1))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        try
        {
            var entries = new List<SnapshotEntry>();
            var entry = new PROCESSENTRY32();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if (!Process32FirstW(snapshot, ref entry))
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            while (true)
            {
                entries.Add(new SnapshotEntry
                {
                    Pid = entry.th32ProcessID,
                    ParentPid = entry.th32ParentProcessID,
                    Depth = 0,
                    CreationFileTime = 0
                });
                entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
                if (!Process32NextW(snapshot, ref entry))
                {
                    var error = Marshal.GetLastWin32Error();
                    if (error != ERROR_NO_MORE_FILES)
                    {
                        throw new Win32Exception(error);
                    }
                    break;
                }
            }
            return entries;
        }
        finally
        {
            CloseHandle(snapshot);
        }
    }

    private static long ToLong(FILETIME value)
    {
        return ((long)value.High << 32) | value.Low;
    }

    private static void WaitForNaturalExit(List<Candidate> candidates)
    {
        var stopwatch = Stopwatch.StartNew();
        while (stopwatch.ElapsedMilliseconds < NATURAL_EXIT_GRACE_MILLISECONDS)
        {
            var anyRunning = false;
            foreach (var candidate in candidates)
            {
                if (WaitForSingleObject(candidate.Handle, 0) != WAIT_OBJECT_0)
                {
                    anyRunning = true;
                    break;
                }
            }
            if (!anyRunning)
            {
                return;
            }
            Thread.Sleep(10);
        }
    }

    private static bool TryParseUnsignedDecimal(string value, int maximumDigits, out ulong result)
    {
        result = 0;
        if (value.Length == 0 ||
            value.Length > maximumDigits ||
            value[0] == '0')
        {
            return false;
        }
        for (var index = 0; index < value.Length; index++)
        {
            if (value[index] < '0' || value[index] > '9')
            {
                return false;
            }
        }
        return ulong.TryParse(
            value,
            NumberStyles.None,
            CultureInfo.InvariantCulture,
            out result);
    }
}
'@
  [GhostCaseProcessTree]::Run()
} catch {
  [Console]::Out.WriteLine('FATAL')
  [Console]::Out.Flush()
  exit 1
}
`;

export type WindowsExitedTreeCleanup =
  | { readonly kind: 'confirmed' }
  | { readonly kind: 'failed'; readonly detail: string }
  | { readonly kind: 'none' };

type HelperChild = ChildProcessByStdio<Writable, Readable, null>;

interface PendingRequest {
  readonly resolve: (result: WindowsExitedTreeCleanup) => void;
  readonly timeout: NodeJS.Timeout;
}

class WindowsTreeHelper {
  readonly #child: HelperChild;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #readyPromise: Promise<void>;
  #buffer = '';
  #closed = false;
  #nextRequestId = 1;
  #ready = false;

  constructor() {
    this.#child = spawnHelper();
    this.#child.stdout.setEncoding('utf8');
    this.#child.stdout.on('data', (chunk: string) => {
      this.#acceptOutput(chunk);
    });
    this.#child.stdin.on('error', () => {
      this.#failAll('Windows process-tree helper input failed.');
      this.#stop();
    });
    this.#child.once('error', () => {
      this.#failAll('Windows process-tree helper failed.');
    });
    this.#child.once('close', (code, signal) => {
      this.#closed = true;
      this.#failAll(
        `Windows process-tree helper closed unexpectedly (${code === null ? (signal ?? 'unknown') : String(code)}).`,
      );
    });
    this.#readyPromise = this.#waitForReady();
  }

  get closed(): boolean {
    return this.#closed;
  }

  async ready(): Promise<void> {
    await this.#readyPromise;
  }

  async cleanup(
    rootProcessId: number,
    startedAtUnixMilliseconds: number,
    closedAtUnixMilliseconds: number,
  ): Promise<WindowsExitedTreeCleanup> {
    await this.ready();
    if (this.#closed) {
      return failedCleanup('Windows process-tree helper is unavailable.');
    }

    const requestId = this.#nextRequestId;
    this.#nextRequestId = this.#nextRequestId === 9_999_999_999 ? 1 : this.#nextRequestId + 1;
    if (this.#pending.has(requestId)) {
      return failedCleanup('Windows process-tree helper request identifiers were exhausted.');
    }

    this.#setReferenced(true);
    return await new Promise<WindowsExitedTreeCleanup>((resolve) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);
        this.#stop();
        resolve(failedCleanup('Windows descendant cleanup exceeded its bounded timeout.'));
      }, HELPER_REQUEST_TIMEOUT_MILLISECONDS);
      this.#pending.set(requestId, { resolve, timeout });

      const line = [
        String(requestId),
        String(rootProcessId),
        unixMillisecondsToFileTime(startedAtUnixMilliseconds),
        unixMillisecondsToFileTime(closedAtUnixMilliseconds, true),
      ].join(':');
      this.#child.stdin.write(`${line}\n`, 'utf8', (error) => {
        if (error !== null && error !== undefined) {
          const pending = this.#pending.get(requestId);
          if (pending !== undefined) {
            clearTimeout(pending.timeout);
            this.#pending.delete(requestId);
            pending.resolve(failedCleanup('Windows process-tree helper input failed.'));
            this.#releaseIfIdle();
          }
        }
      });
    });
  }

  async #waitForReady(): Promise<void> {
    this.#setReferenced(true);
    try {
      if (this.#ready) {
        return;
      }
      if (this.#closed) {
        throw new Error('Windows process-tree helper failed during startup.');
      }
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
          finish(() => {
            reject(new Error('Windows process-tree helper did not become ready.'));
          });
        }, HELPER_START_TIMEOUT_MILLISECONDS);
        const removeListeners = (): void => {
          clearTimeout(timeout);
          this.#child.removeListener('ready', onReady);
          this.#child.removeListener('error', onFailure);
          this.#child.removeListener('close', onFailure);
        };
        const finish = (settle: () => void): void => {
          if (settled) {
            return;
          }
          settled = true;
          removeListeners();
          settle();
        };
        const onReady = (): void => {
          finish(resolve);
        };
        const onFailure = (): void => {
          finish(() => {
            reject(new Error('Windows process-tree helper failed during startup.'));
          });
        };
        this.#child.once('ready', onReady);
        this.#child.once('error', onFailure);
        this.#child.once('close', onFailure);
        if (this.#ready) {
          onReady();
        } else if (this.#closed) {
          onFailure();
        }
      });
    } catch (error) {
      this.#stop();
      throw error;
    } finally {
      this.#releaseIfIdle();
    }
  }

  #acceptOutput(chunk: string): void {
    this.#buffer += chunk;

    for (;;) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) {
        break;
      }
      const line = this.#buffer.slice(0, newline).replace(/\r$/u, '');
      this.#buffer = this.#buffer.slice(newline + 1);
      this.#acceptLine(line);
      if (this.#closed) {
        return;
      }
    }

    if (Buffer.byteLength(this.#buffer, 'utf8') > MAX_PROTOCOL_BUFFER_BYTES) {
      this.#failAll('Windows process-tree helper produced invalid output.');
      this.#stop();
    }
  }

  #acceptLine(line: string): void {
    if (!this.#ready) {
      if (line !== 'READY') {
        this.#failAll('Windows process-tree helper failed during startup.');
        this.#stop();
        return;
      }
      this.#ready = true;
      this.#child.emit('ready');
      return;
    }
    if (line === 'FATAL') {
      this.#failAll('Windows process-tree helper reported a fatal error.');
      this.#stop();
      return;
    }

    const match = /^([1-9]\d{0,9}):(NONE|CONFIRMED:[1-9]\d{0,3}|FAILED:[A-Z0-9_]{1,32})$/u.exec(
      line,
    );
    if (match === null) {
      this.#failAll('Windows process-tree helper produced invalid output.');
      this.#stop();
      return;
    }
    const requestId = Number.parseInt(match[1] ?? '', 10);
    const pending = this.#pending.get(requestId);
    if (pending === undefined) {
      this.#failAll('Windows process-tree helper returned an unknown request.');
      this.#stop();
      return;
    }
    clearTimeout(pending.timeout);
    this.#pending.delete(requestId);
    pending.resolve(parseHelperResult(match[2] ?? ''));
    this.#releaseIfIdle();
  }

  #failAll(detail: string): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.resolve(failedCleanup(detail));
    }
    this.#pending.clear();
    this.#releaseIfIdle();
  }

  #releaseIfIdle(): void {
    if (this.#pending.size === 0 && this.#ready) {
      this.#setReferenced(false);
    }
  }

  #setReferenced(referenced: boolean): void {
    if (referenced) {
      this.#child.ref();
    } else {
      this.#child.unref();
    }
    setStreamReferenced(this.#child.stdin, referenced);
    setStreamReferenced(this.#child.stdout, referenced);
  }

  #stop(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      this.#child.kill('SIGKILL');
    } catch {
      // Pending requests already receive a fail-closed result.
    }
  }
}

let helperPromise: Promise<WindowsTreeHelper> | undefined;

export function warmWindowsTreeHelper(): void {
  if (process.platform === 'win32') {
    void getWindowsTreeHelper().catch(() => undefined);
  }
}

/**
 * Performs bounded post-exit containment for descendants still linked in the Windows
 * process snapshot. Per-generation creation-time filtering and retained descendant
 * handles narrow PID-reuse races. The root lifetime is millisecond-bounded because Node
 * does not expose its Windows process handle here; an already-exited intermediate
 * generation or a child that explicitly escapes the ancestry tree cannot be reconstructed.
 */
export async function cleanupExitedWindowsDescendants(
  rootProcessId: number,
  startedAtUnixMilliseconds: number,
  closedAtUnixMilliseconds: number,
): Promise<WindowsExitedTreeCleanup> {
  if (
    !Number.isSafeInteger(rootProcessId) ||
    rootProcessId <= 0 ||
    rootProcessId > MAX_WINDOWS_PROCESS_ID
  ) {
    return failedCleanup('Windows descendant cleanup received an invalid process id.');
  }
  if (
    !Number.isSafeInteger(startedAtUnixMilliseconds) ||
    !Number.isSafeInteger(closedAtUnixMilliseconds) ||
    startedAtUnixMilliseconds < 0 ||
    closedAtUnixMilliseconds < startedAtUnixMilliseconds ||
    closedAtUnixMilliseconds > MAX_WINDOWS_FILETIME_UNIX_MILLISECONDS
  ) {
    return failedCleanup('Windows descendant cleanup received an invalid lifetime.');
  }

  try {
    const helper = await getWindowsTreeHelper();
    return await helper.cleanup(rootProcessId, startedAtUnixMilliseconds, closedAtUnixMilliseconds);
  } catch {
    return failedCleanup('Windows process-tree helper could not be initialized.');
  }
}

async function getWindowsTreeHelper(): Promise<WindowsTreeHelper> {
  if (helperPromise === undefined) {
    const helper = new WindowsTreeHelper();
    const pending = helper.ready().then(() => helper);
    const owner: { promise: Promise<WindowsTreeHelper> } = { promise: pending };
    const tracked = pending.catch((error: unknown) => {
      if (helperPromise === owner.promise) {
        helperPromise = undefined;
      }
      throw error;
    });
    owner.promise = tracked;
    helperPromise = tracked;
  }
  const observed = helperPromise;
  const helper = await observed;
  if (helper.closed) {
    if (helperPromise === observed) {
      helperPromise = undefined;
    }
    return await getWindowsTreeHelper();
  }
  return helper;
}

function spawnHelper(): HelperChild {
  const windowsDirectory = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const temporaryDirectory = win32.resolve(tmpdir());
  const executable = resolvePowerShellExecutable(windowsDirectory);
  return spawn(
    executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_TREE_HELPER_SCRIPT],
    {
      cwd: windowsDirectory,
      env: {
        SystemRoot: windowsDirectory,
        TEMP: temporaryDirectory,
        TMP: temporaryDirectory,
        WINDIR: windowsDirectory,
      },
      shell: false,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    },
  );
}

function resolvePowerShellExecutable(windowsDirectory: string): string {
  const systemRoot = win32.parse(windowsDirectory).root;
  const modernPowerShell = win32.join(systemRoot, 'Program Files', 'PowerShell', '7', 'pwsh.exe');
  try {
    const metadata = lstatSync(modernPowerShell);
    if (metadata.isFile() && !metadata.isSymbolicLink()) {
      return modernPowerShell;
    }
  } catch {
    // Windows PowerShell remains the dependency-free fallback.
  }
  return win32.join(windowsDirectory, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function parseHelperResult(message: string): WindowsExitedTreeCleanup {
  if (message === 'NONE') {
    return { kind: 'none' };
  }
  if (/^CONFIRMED:[1-9]\d{0,3}$/u.test(message)) {
    return { kind: 'confirmed' };
  }
  const failure = /^FAILED:([A-Z0-9_]{1,32})$/u.exec(message);
  return failedCleanup(
    `Windows descendant cleanup failed (${failure?.[1] ?? 'INVALID_RESPONSE'}).`,
  );
}

function unixMillisecondsToFileTime(milliseconds: number, includeMillisecondEnd = false): string {
  return (
    BigInt(milliseconds) * WINDOWS_FILETIME_TICKS_PER_MILLISECOND +
    WINDOWS_TO_UNIX_EPOCH_FILETIME +
    (includeMillisecondEnd ? WINDOWS_FILETIME_MILLISECOND_END_OFFSET : 0n)
  ).toString();
}

function setStreamReferenced(stream: Readable | Writable, referenced: boolean): void {
  const referenceable = stream as (Readable | Writable) & {
    ref?: () => void;
    unref?: () => void;
  };
  if (referenced) {
    referenceable.ref?.();
  } else {
    referenceable.unref?.();
  }
}

function failedCleanup(detail: string): WindowsExitedTreeCleanup {
  return { kind: 'failed', detail };
}
