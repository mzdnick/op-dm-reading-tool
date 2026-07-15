import { proxyAthenaRequest } from "../../../src/athenaProxy";

interface PagesContext {
  request: Request;
  params: { dongleId?: string | string[] };
}

export function onRequest(context: PagesContext): Promise<Response> {
  const value = context.params.dongleId;
  const dongleId = Array.isArray(value) ? value[0] ?? "" : value ?? "";
  return proxyAthenaRequest(context.request, dongleId);
}
