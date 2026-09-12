import {it,expect} from 'vitest';
import {cancellationNotice} from './work-actions.js';
it('waits for canonical termination and reconciles cancellation races with final outcomes',()=>{
 for(const status of ['running','queued','needs_attention'] as const)expect(cancellationNotice(status)).toContain('Waiting');
 expect(cancellationNotice('cancelled')).toBe('Execution cancelled.');
 for(const status of ['completed','partial','failed'] as const){expect(cancellationNotice(status)).toContain('Execution ended');expect(cancellationNotice(status)).not.toContain('cancelled');}
});
