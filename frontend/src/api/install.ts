import { apiGet } from "./client";

export interface InstallInfo {
  installUrl: string;
  manifestUrl: string;
}

export async function getInstallInfo(id: string): Promise<InstallInfo> {
  // Use the backend endpoint which respects PUBLIC_BASE_URL setting.
  const data = await apiGet<InstallInfo>("/api/install/" + id + "/url");
  return data;
}
