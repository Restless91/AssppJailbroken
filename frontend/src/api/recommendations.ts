import { apiGet } from "./client";

export interface AppRecommendation {
  id: number;
  name: string;
  artistName: string;
  artworkUrl: string;
  genreName: string;
  rank: number;
}

export function getRecommendations(country: string, limit = 8): Promise<AppRecommendation[]> {
  const params = new URLSearchParams({ country, limit: String(limit) });
  return apiGet<AppRecommendation[]>(`/api/recommendations?${params}`);
}
