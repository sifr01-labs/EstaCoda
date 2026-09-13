import type {SettingField} from '../contracts/desktop-control/index.js';
export const runtimeSettings:readonly SettingField[]=[
  {
    "id": "execution.backend",
    "path": [
      "execution",
      "backend"
    ],
    "section": "runtime",
    "kind": "choice",
    "choices": [
      "host",
      "docker"
    ]
  },
  {
    "id": "execution.imageId",
    "path": [
      "execution",
      "imageId"
    ],
    "section": "runtime",
    "kind": "text"
  },
  {
    "id": "execution.workspaceAccess.value",
    "path": [
      "execution",
      "workspaceAccess",
      "value"
    ],
    "section": "runtime",
    "kind": "choice",
    "choices": [
      "read-only",
      "read-write"
    ]
  },
  {
    "id": "execution.workspaceAccess.requirement",
    "path": [
      "execution",
      "workspaceAccess",
      "requirement"
    ],
    "section": "runtime",
    "kind": "choice",
    "choices": [
      "mandatory",
      "advisory"
    ]
  },
  {
    "id": "execution.commandNetwork.value",
    "path": [
      "execution",
      "commandNetwork",
      "value"
    ],
    "section": "runtime",
    "kind": "choice",
    "choices": [
      "unrestricted",
      "disabled"
    ]
  },
  {
    "id": "execution.commandNetwork.requirement",
    "path": [
      "execution",
      "commandNetwork",
      "requirement"
    ],
    "section": "runtime",
    "kind": "choice",
    "choices": [
      "mandatory",
      "advisory"
    ]
  },
  {
    "id": "execution.credentialCapabilities.value",
    "path": [
      "execution",
      "credentialCapabilities",
      "value"
    ],
    "section": "runtime",
    "kind": "strings"
  },
  {
    "id": "execution.credentialCapabilities.requirement",
    "path": [
      "execution",
      "credentialCapabilities",
      "requirement"
    ],
    "section": "runtime",
    "kind": "choice",
    "choices": [
      "mandatory",
      "advisory"
    ]
  },
  {
    "id": "execution.lifetime.value",
    "path": [
      "execution",
      "lifetime",
      "value"
    ],
    "section": "runtime",
    "kind": "choice",
    "choices": [
      "host",
      "session"
    ]
  },
  {
    "id": "execution.lifetime.requirement",
    "path": [
      "execution",
      "lifetime",
      "requirement"
    ],
    "section": "runtime",
    "kind": "choice",
    "choices": [
      "mandatory",
      "advisory"
    ]
  },
  {
    "id": "execution.limits.value.cpu",
    "path": [
      "execution",
      "limits",
      "value",
      "cpu"
    ],
    "section": "runtime",
    "kind": "number"
  },
  {
    "id": "execution.limits.value.memoryBytes",
    "path": [
      "execution",
      "limits",
      "value",
      "memoryBytes"
    ],
    "section": "runtime",
    "kind": "number"
  },
  {
    "id": "execution.limits.value.pids",
    "path": [
      "execution",
      "limits",
      "value",
      "pids"
    ],
    "section": "runtime",
    "kind": "number"
  },
  {
    "id": "execution.limits.value.outputBytes",
    "path": [
      "execution",
      "limits",
      "value",
      "outputBytes"
    ],
    "section": "runtime",
    "kind": "number"
  },
  {
    "id": "execution.limits.value.timeoutMs",
    "path": [
      "execution",
      "limits",
      "value",
      "timeoutMs"
    ],
    "section": "runtime",
    "kind": "number"
  },
  {
    "id": "execution.limits.requirement",
    "path": [
      "execution",
      "limits",
      "requirement"
    ],
    "section": "runtime",
    "kind": "choice",
    "choices": [
      "mandatory",
      "advisory"
    ]
  }
];
