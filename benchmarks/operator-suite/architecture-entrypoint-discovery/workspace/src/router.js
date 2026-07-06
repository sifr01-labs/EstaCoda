import { listOrders } from "./services/orders.js";

export function route(request) {
  if (request.path === "/orders") {
    return listOrders();
  }
  return { status: 404 };
}
