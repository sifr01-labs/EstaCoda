import type { ProviderId, ResolvedModelRoute } from "../contracts/provider.js";
import { getProviderDefaultBaseUrl } from "./provider-metadata.js";

export type ProviderRouteDestination = {
  inference: "local" | "hosted";
  key: string;
};

export function providerRouteDestination(route: ResolvedModelRoute): ProviderRouteDestination {
  return providerEndpointDestination(route);
}

export function providerEndpointDestination(
  route: { readonly provider: ProviderId; readonly baseUrl?: string }
): ProviderRouteDestination {
  const rawBaseUrl = route.baseUrl ?? getProviderDefaultBaseUrl(route.provider);
  if (rawBaseUrl === undefined) {
    return route.provider === "local"
      ? { inference: "local", key: "local@loopback" }
      : { inference: "hosted", key: `${route.provider}@provider-default` };
  }
  try {
    const url = new URL(rawBaseUrl);
    const hostname = url.hostname.toLowerCase();
    const local = hostname === "localhost" || hostname.endsWith(".localhost") ||
      hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    const path = url.pathname.replace(/\/+$/u, "") || "/";
    return {
      inference: local ? "local" : "hosted",
      key: `${route.provider}@${url.origin}${path}`
    };
  } catch {
    return { inference: "hosted", key: `${route.provider}@custom-endpoint` };
  }
}

export function isLocalProviderEndpoint(
  route: { readonly provider: ProviderId; readonly baseUrl?: string }
): boolean {
  return providerEndpointDestination(route).inference === "local";
}

export function isLocalProviderRoute(route: ResolvedModelRoute): boolean {
  return providerRouteDestination(route).inference === "local";
}
