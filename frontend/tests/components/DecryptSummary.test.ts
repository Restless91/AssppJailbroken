import { describe, expect, it } from 'vitest';
import { summarizeDecryptEvents } from '../../src/components/Download/DecryptSummary';
import type { DecryptEvent } from '../../src/types';

describe('summarizeDecryptEvents', () => {
  it('uses the same per-binary framework count for compact and detail summaries', () => {
    const frameworkEvents: DecryptEvent[] = Array.from({ length: 14 }, (_, index) => ({
      kind: 'framework',
      status: 'decrypted',
      path: `Eggplant.app/Frameworks/F${index}.framework/F${index}`,
      message: `task-memory decrypted: F${index}`,
    }));
    const events: DecryptEvent[] = [
      {
        kind: 'main',
        status: 'decrypted',
        path: 'Eggplant.app/Eggplant',
        message: 'task-memory decrypted: Eggplant.app/Eggplant',
      },
      ...frameworkEvents,
      {
        kind: 'extension',
        status: 'failed',
        path: 'Eggplant.app/PlugIns/Notification.appex/Notification',
        message: 'warning: extension decryption failed',
      },
      {
        kind: 'report',
        status: 'info',
        reportTotal: 18,
        reportDecrypted: 16,
        reportRemaining: 2,
        reportMainRemaining: 0,
        reportFrameworkRemaining: 0,
        reportExtensionRemaining: 2,
        message:
          'cryptid-report: total=18 decrypted=16 remaining=2 mainRemaining=0 frameworkRemaining=0 extensionRemaining=2',
      },
    ];

    expect(summarizeDecryptEvents(events)).toMatchObject({
      main: 1,
      frameworks: 14,
      frameworkSkipped: 0,
      extensions: 0,
      extensionSkipped: 2,
      permissionLabel: 'partial',
    });
  });

  it('only grants the full permission label when every Mach-O has cryptid zero', () => {
    const report: DecryptEvent = {
      kind: 'report', status: 'info', reportTotal: 18, reportDecrypted: 18,
      reportRemaining: 0, reportMainRemaining: 0, reportFrameworkRemaining: 0,
      reportExtensionRemaining: 0,
      message: 'cryptid-report: total=18 decrypted=18 remaining=0 mainRemaining=0 frameworkRemaining=0 extensionRemaining=0',
    };
    expect(summarizeDecryptEvents([report]).permissionLabel).toBe('full');
    expect(summarizeDecryptEvents([{ ...report, reportRemaining: 1 }]).permissionLabel).toBe('partial');
    expect(summarizeDecryptEvents([]).permissionLabel).toBeNull();
  });
});
