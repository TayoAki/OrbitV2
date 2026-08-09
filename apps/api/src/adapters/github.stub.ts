// ─────────────────────────────────────────────────────────────────────────────
// SimGitHub — an in-memory stand-in for the GitHub control-plane client. It models
// PRs (with a mutable head SHA), per-SHA checks, PR reviews, SHA-conditioned
// merge, scoped-token minting, and the R8 write-access re-check. The `set*`/`push*`
// methods are the "external world" simulation used by the demo + tests; in prod
// these facts arrive via webhooks and the real GitHub API.
// ─────────────────────────────────────────────────────────────────────────────
import type { GitHubClient, GitHubPr, ScopedToken, ScopedTokenRequest } from "../ports";
import type { CheckObservation, ReviewObservation, Repository } from "../domain";

interface PrRow {
  number: number;
  base: string;
  branch: string;
  headSha: string;
  mergeable: GitHubPr["mergeable"];
  merged: boolean;
}

export class SimGitHub implements GitHubClient {
  private prs = new Map<string, PrRow>(); // `${repoId}#${prNumber}`
  private nextPrByRepo = new Map<string, number>();
  private branchHead = new Map<string, string>(); // `${repoId}:${branch}` -> sha
  private checks = new Map<string, CheckObservation[]>(); // `${repoId}:${sha}`
  private reviews = new Map<string, ReviewObservation[]>(); // `${repoId}#${prNumber}`
  private userWrite = new Map<string, boolean>(); // `${userId}:${repoId}` -> bool

  // ── external-world simulation controls ─────────────────────────────────────
  /** Simulate the runner pushing a commit — moves the branch tip (and any open PR). */
  pushBranch(repo: Repository, branch: string, sha: string): void {
    this.branchHead.set(`${repo.id}:${branch}`, sha);
    for (const pr of this.prs.values()) {
      if (pr.branch === branch && !pr.merged) pr.headSha = sha;
    }
  }
  setChecks(repo: Repository, sha: string, checks: CheckObservation[]): void {
    this.checks.set(`${repo.id}:${sha}`, checks);
  }
  setReview(repo: Repository, prNumber: number, review: ReviewObservation): void {
    const key = `${repo.id}#${prNumber}`;
    this.reviews.set(key, [...(this.reviews.get(key) ?? []), review]);
  }
  setMergeable(repo: Repository, prNumber: number, m: GitHubPr["mergeable"]): void {
    const pr = this.prs.get(`${repo.id}#${prNumber}`);
    if (pr) pr.mergeable = m;
  }
  setUserWrite(githubUserId: number, repo: Repository, has: boolean): void {
    this.userWrite.set(`${githubUserId}:${repo.id}`, has);
  }

  // ── GitHubClient ───────────────────────────────────────────────────────────
  async mintScopedInstallationToken(req: ScopedTokenRequest): Promise<ScopedToken> {
    // Real impl: sign a JWT with the App private key, exchange for a 1-hour token
    // scoped to req.repositoryIds + req.permissions. Never leaves the control plane.
    return { token: `ghs_sim_${req.installationId}_${Date.now()}`, expiresAt: new Date(Date.now() + 3600_000).toISOString() };
  }

  async userHasWriteAccess(githubUserId: number, repo: Repository): Promise<boolean> {
    return this.userWrite.get(`${githubUserId}:${repo.id}`) ?? true;
  }

  async findOpenPr(repo: Repository, branch: string): Promise<GitHubPr | null> {
    for (const pr of this.prs.values()) {
      if (pr.branch === branch && !pr.merged) return this.toGh(pr);
    }
    return null;
  }

  async createPullRequest(input: { repo: Repository; head: string; base: string; title: string; body: string }): Promise<GitHubPr> {
    const existing = await this.findOpenPr(input.repo, input.head);
    if (existing) return existing; // idempotent
    const n = (this.nextPrByRepo.get(input.repo.id) ?? 1);
    this.nextPrByRepo.set(input.repo.id, n + 1);
    const headSha = this.branchHead.get(`${input.repo.id}:${input.head}`) ?? "0000000";
    const row: PrRow = { number: n, base: input.base, branch: input.head, headSha, mergeable: "MERGEABLE", merged: false };
    this.prs.set(`${input.repo.id}#${n}`, row);
    return this.toGh(row);
  }

  async getPullRequest(repo: Repository, prNumber: number): Promise<GitHubPr> {
    const pr = this.prs.get(`${repo.id}#${prNumber}`);
    if (!pr) throw new Error(`PR ${prNumber} not found`);
    return this.toGh(pr);
  }

  async listChecks(repo: Repository, headSha: string): Promise<CheckObservation[]> {
    return (this.checks.get(`${repo.id}:${headSha}`) ?? []).map((c) => ({ ...c }));
  }

  async listReviews(repo: Repository, prNumber: number): Promise<ReviewObservation[]> {
    return (this.reviews.get(`${repo.id}#${prNumber}`) ?? []).map((r) => ({ ...r }));
  }

  async publishGateCheck(): Promise<void> {
    // Real impl: create/update the `Shipbot / Gate` check run for the head SHA.
  }

  async submitApprovalReview(): Promise<void> {
    // Real impl: submit an APPROVE review as the user, so the approval is visible
    // in GitHub's own review/audit surface.
  }

  async merge(input: { repo: Repository; prNumber: number; expectedHeadSha: string }): Promise<{ merged: boolean; sha: string | null }> {
    const pr = this.prs.get(`${input.repo.id}#${input.prNumber}`);
    if (!pr) return { merged: false, sha: null };
    // The classic race guard: refuse to merge if the tip moved since approval.
    if (pr.headSha !== input.expectedHeadSha) return { merged: false, sha: null };
    if (pr.mergeable !== "MERGEABLE") return { merged: false, sha: null };
    pr.merged = true;
    return { merged: true, sha: pr.headSha };
  }

  private toGh(pr: PrRow): GitHubPr {
    return { number: pr.number, headSha: pr.headSha, base: pr.base, branch: pr.branch, mergeable: pr.mergeable, merged: pr.merged };
  }
}
