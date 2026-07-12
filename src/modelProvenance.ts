import type { RouteInfo } from "./routes";

const OPENPILOT_COMMITS_URL = "https://api.github.com/repos/commaai/openpilot/commits";

interface GitHubCommit {
  sha?: string;
  commit?: {
    author?: { date?: string };
    committer?: { date?: string };
    message?: string;
  };
}

export interface DmModelProvenance {
  version?: string;
  routeDate?: string;
  gitCommit?: string;
  gitBranch?: string;
  artifactPath?: string;
  artifactCommit?: string;
  artifactDate?: string;
  artifactChange?: string;
  source: "github" | "route";
}

const artifactHistoryCache = new Map<string, Promise<Partial<DmModelProvenance> | null>>();

export function routeModelProvenance(routeInfo: RouteInfo | null): DmModelProvenance {
  return {
    version: routeInfo?.version,
    routeDate: routeInfo?.start_time ?? routeInfo?.startTime,
    gitCommit: routeInfo?.git_commit ?? routeInfo?.gitCommit,
    gitBranch: routeInfo?.git_branch ?? routeInfo?.gitBranch,
    source: "route",
  };
}

export async function resolveDmModelProvenance(
  routeInfo: RouteInfo | null,
  fetcher: typeof fetch = fetch,
): Promise<DmModelProvenance> {
  const route = routeModelProvenance(routeInfo);
  if (!route.gitCommit) return route;

  let lookup = artifactHistoryCache.get(route.gitCommit);
  if (!lookup) {
    lookup = findArtifactHistory(route.gitCommit, route.version, fetcher);
    artifactHistoryCache.set(route.gitCommit, lookup);
  }
  const artifact = await lookup;
  return artifact ? { ...route, ...artifact, source: "github" } : route;
}

export function formatModelProvenance(provenance: DmModelProvenance, checking = false): string {
  const parts: string[] = [];
  if (provenance.artifactDate) parts.push(`DM artifact last changed ${formatDate(provenance.artifactDate)}`);
  else if (checking && provenance.gitCommit) parts.push("DM artifact history checking…");
  else parts.push("DM artifact history unavailable");
  if (provenance.routeDate) parts.push(`drive recorded ${formatDate(provenance.routeDate)}`);
  if (provenance.version) parts.push(`openpilot ${provenance.version}`);
  return parts.join(" · ");
}

export function modelProvenanceDetails(provenance: DmModelProvenance): string {
  const parts: string[] = [];
  if (provenance.gitCommit) parts.push(`Route commit ${shortSha(provenance.gitCommit)}`);
  if (provenance.gitBranch) parts.push(`branch ${provenance.gitBranch}`);
  if (provenance.artifactPath) parts.push(`artifact ${provenance.artifactPath}`);
  if (provenance.artifactCommit) parts.push(`artifact commit ${shortSha(provenance.artifactCommit)}`);
  if (provenance.artifactChange) parts.push(provenance.artifactChange);
  return parts.join(" · ");
}

async function findArtifactHistory(
  gitCommit: string,
  version: string | undefined,
  fetcher: typeof fetch,
): Promise<Partial<DmModelProvenance> | null> {
  for (const artifactPath of artifactCandidates(version)) {
    const query = new URLSearchParams({ sha: gitCommit, path: artifactPath, per_page: "1" });
    let response: Response;
    try {
      response = await fetcher(`${OPENPILOT_COMMITS_URL}?${query}`, {
        headers: { Accept: "application/vnd.github+json" },
      });
    } catch {
      return null;
    }
    if (!response.ok) {
      if (response.status === 403 || response.status === 429) return null;
      continue;
    }
    const commits = await response.json() as GitHubCommit[];
    const commit = commits[0];
    if (!commit) continue;
    return {
      artifactPath,
      artifactCommit: commit.sha,
      artifactDate: commit.commit?.committer?.date ?? commit.commit?.author?.date,
      artifactChange: commit.commit?.message?.split("\n", 1)[0],
    };
  }
  return null;
}

function artifactCandidates(version: string | undefined): string[] {
  const match = version?.match(/^(\d+)\.(\d+)/);
  const major = Number(match?.[1] ?? 0);
  const minor = Number(match?.[2] ?? 0);
  const modern = major > 0 || minor >= 11;
  const tinygrad = "selfdrive/modeld/models/dmonitoring_model_tinygrad.pkl.chunk01of01";
  const onnx = "selfdrive/modeld/models/dmonitoring_model.onnx";
  const qcom = "selfdrive/modeld/models/dmonitoring_model_q.dlc";
  return modern
    ? [tinygrad, onnx, qcom]
    : [onnx, qcom, tinygrad, "models/dmonitoring_model.onnx", "models/dmonitoring_model_q.dlc"];
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function shortSha(sha: string): string {
  return sha.slice(0, 8);
}
