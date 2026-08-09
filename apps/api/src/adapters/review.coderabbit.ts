// CodeRabbit review provider (skeleton). CodeRabbit auto-reviews new PRs and does
// incremental reviews on new commits, and its Request-Changes workflow submits a
// native GitHub `Request changes` review that flips to `Approve` once satisfied —
// which maps directly onto CHANGES_REQUESTED → agent revision, APPROVED → gate pass.
// The state machine's source of truth is the NORMALIZED review on GitHub, so this
// provider only needs `isCurrent`; add Greptile behind the same seam.
import type { ReviewProvider } from "../ports";
import type { ReviewObservation, Repository } from "../domain";

export class CodeRabbitReviewProvider implements ReviewProvider {
  readonly name = "coderabbit";
  isCurrent(review: ReviewObservation, headSha: string): boolean {
    return review.headSha === headSha;
  }
  async trigger(_repo: Repository, _prNumber: number): Promise<void> {
    // Real impl: no-op — CodeRabbit reviews automatically on PR open / new commits.
  }
}
