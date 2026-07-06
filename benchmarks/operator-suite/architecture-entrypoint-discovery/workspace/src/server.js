import { route } from "./router.js";

export function handleRequest(request) {
  return route(request);
}
