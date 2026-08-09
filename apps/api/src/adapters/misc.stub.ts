// Stub secret + artifact stores. Prod: KMS-envelope secrets; encrypted object store.
import type { SecretStore, ArtifactStore } from "../ports";
import { slug } from "../domain";

export class PassthroughSecrets implements SecretStore {
  async encrypt(plaintext: string): Promise<string> {
    return Buffer.from(plaintext, "utf8").toString("base64");
  }
  async decrypt(ciphertext: string): Promise<string> {
    return Buffer.from(ciphertext, "base64").toString("utf8");
  }
}

export class StubArtifacts implements ArtifactStore {
  async put(meta: { runId: string; kind: string; contentType: string }): Promise<{ id: string; uploadUrl: string }> {
    const id = slug();
    return { id, uploadUrl: `stub://artifacts/${meta.runId}/${meta.kind}/${id}` };
  }
}
