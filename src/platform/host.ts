import type { PlatformName } from '../domain/model.js';

export function currentHostPlatform(
  platform: NodeJS.Platform = process.platform,
): PlatformName | undefined {
  switch (platform) {
    case 'linux':
    case 'win32':
      return platform;
    default:
      return undefined;
  }
}
