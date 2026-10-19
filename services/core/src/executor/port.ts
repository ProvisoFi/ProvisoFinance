import type { Spec } from "@proviso/dsl";

export interface ExecutorPort {
  onFire(e: { fireId: string; thesisId: bigint; owner: string; spec: Spec; mark: number; at: Date; n: number }): Promise<void>;
  onMark(coin: string, mark: number, at: Date): void;
  stop(thesisId: bigint, owner: string): Promise<void>;
}
