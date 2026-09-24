import type {ConnectionOperationIssue} from '@estacoda/control-protocol';
import type {MessageKey} from '../../shared/i18n/index.js';
/** Only fixed product copy crosses from an operation reason into the UI. */
export const operationIssueMessages:Record<ConnectionOperationIssue,MessageKey>={
 python_required:'Install a compatible Python interpreter, then retry.',
 venv_failed:'Could not create the Python environment. Check your Python installation and retry.',
 packages_failed:'Package download or installation failed. Check your network connection and retry.',
 verification_failed:'Installed software could not be verified. Retry installation to repair it.',
 permission_denied:'Installation was denied by filesystem permissions. Check access to EstaCoda’s managed software directory.',
 disk_insufficient:'There is not enough free disk space to install this software.',
 installation_failed:'Installation failed. Check your Python installation and retry.',
 gateway_not_stopped:'Stop the gateway before updating its build. Shared work must finish or be stopped first.',
 runtime_unavailable:'This build cannot update the gateway. Use a packaged Desktop build with a retained runtime.',
 activation_failed:'The gateway update could not be verified. Check gateway status; recovery may require repair.'
};
