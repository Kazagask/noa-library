export interface EmbeddingProvider {
  name: string;
  embed(texts: string[]): Promise<number[][]>;
  similarity(a: number[], b: number[]): number;
}

/** 默认不接任何模型；可选 Provider 通过这个接口注入，不强制付费服务。 */
export class NoopEmbeddingProvider implements EmbeddingProvider {
  name = 'noop';
  async embed(texts: string[]): Promise<number[][]> { return texts.map(() => []); }
  similarity(): number { return 0; }
}

let current: EmbeddingProvider = new NoopEmbeddingProvider();
export function setEmbeddingProvider(provider: EmbeddingProvider): void { current = provider; }
export function getEmbeddingProvider(): EmbeddingProvider { return current; }
