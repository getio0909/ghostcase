import { readFile, writeFile } from 'node:fs/promises';

const caseId = process.argv[2];

async function readPersona() {
  try {
    const raw = await readFile('profile.json', 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed.persona === 'string' ? parsed.persona : 'unknown';
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return 'neutral';
    }
    throw error;
  }
}

switch (caseId) {
  case 'noise': {
    await writeFile('cache.json', JSON.stringify({ warmedBy: 'noise' }), 'utf8');
    process.stdout.write(`${JSON.stringify({ caseId, ok: true })}\n`);
    break;
  }
  case 'polluter': {
    await writeFile(
      'profile.json',
      JSON.stringify({ persona: 'pirate', writtenBy: 'polluter' }),
      'utf8',
    );
    process.stdout.write(`${JSON.stringify({ caseId, ok: true })}\n`);
    break;
  }
  case 'victim': {
    const persona = await readPersona();
    process.stdout.write(
      `${JSON.stringify({
        caseId,
        observedPersona: persona,
        ok: persona === 'neutral',
      })}\n`,
    );
    break;
  }
  default:
    throw new Error('Expected one of: noise, polluter, victim.');
}
