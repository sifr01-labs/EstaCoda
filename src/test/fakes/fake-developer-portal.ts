import { FakeCdpAuthPortalSocket } from "./fake-cdp-auth-portal.js";

export const FAKE_DEVELOPER_PORTAL_ORIGIN = "https://93.184.216.34";
export const FAKE_DEVELOPER_PORTAL_URL = `${FAKE_DEVELOPER_PORTAL_ORIGIN}/protected-values`;

/** Configures a supervised test page whose values are readable only by the protected-source transaction. */
export function showProtectedProvisioningValues(
  socket: FakeCdpAuthPortalSocket,
  values: readonly [string, string],
): void {
  socket.documentCurrent = true;
  socket.frameId = "main-frame";
  socket.protectedSourceValues.clear();
  socket.protectedSourceValues.set(0, values[0]);
  socket.protectedSourceValues.set(1, values[1]);
  socket.snapshot = {
    url: FAKE_DEVELOPER_PORTAL_URL,
    title: "Developer portal",
    text: "Protected application values are ready.",
    elements: [
      { ref: "@e1", role: "textbox", name: "Application identifier" },
      { ref: "@e2", role: "textbox", name: "Application secret" },
    ],
  };
}

export function replaceProtectedProvisioningValue(
  socket: FakeCdpAuthPortalSocket,
  elementIndex: 0 | 1,
  value: string,
): void {
  socket.protectedSourceValues.set(elementIndex, value);
}
