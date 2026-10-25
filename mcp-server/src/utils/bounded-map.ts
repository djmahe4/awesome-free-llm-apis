/** A Map that keeps only the `limit` most recently set entries (setting an existing key refreshes it). */
export class BoundedMap<K, V> extends Map<K, V> {
  constructor(readonly limit: number) { super(); }
  override set(key: K, value: V): this {
    if (this.has(key)) this.delete(key);
    super.set(key, value);
    while (this.size > this.limit) this.delete(this.keys().next().value as K);
    return this;
  }
}
