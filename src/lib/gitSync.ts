import type { GitSyncRepo } from "./types";

export function gitSyncRepoIsDetached(repo: Pick<GitSyncRepo, "branch">): boolean {
  const branch = repo.branch?.trim();
  return !branch || branch.toUpperCase() === "HEAD";
}
