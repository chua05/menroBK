// In-memory Firestore stand-in for credential-free tests of the ADC registration path (no SDK, no network).
// Transactions buffer writes and apply them atomically after the callback succeeds; read-only transactions
// reject writes; create() fails when the document exists. failWriteTransaction(n) simulates an outage on
// the n-th write transaction (nothing from that transaction is applied).
function createMemoryFirestore({ projectId, databaseId = "(default)" } = {}) {
  const data = new Map();
  const table = (name) => { if (!data.has(name)) data.set(name, new Map()); return data.get(name); };
  const clone = (value) => (value === undefined ? undefined : structuredClone(value));
  const docRef = (collection, id) => ({ kind: "doc", collection, id, path: `${collection}/${id}` });
  const query = (collection, filters = [], max = Infinity) => ({ kind: "query", collection, filters, max,
    where: (field, op, value) => query(collection, [...filters, [field, op, value]], max),
    select: () => query(collection, filters, max), limit: (count) => query(collection, filters, count), doc: (id) => docRef(collection, id) });
  const snapshot = (ref) => ({ id: ref.id, exists: table(ref.collection).has(ref.id), data: () => clone(table(ref.collection).get(ref.id)) });
  // Like Firestore, a dotted field path ("source.plantingReportId") matches a nested field.
  const at = (value, field) => field.split(".").reduce((node, key) => node?.[key], value);
  const matches = (value, [field, op, expected]) => (op === "==" ? at(value, field) === expected : op === "in" ? expected.includes(at(value, field)) : false);
  let writeTransactions = 0, failOn = 0;
  const applied = [];

  async function runTransaction(callback, options = {}) {
    const readOnly = options.readOnly === true;
    if (!readOnly) writeTransactions++;
    const buffer = [];
    const guard = (op) => { if (readOnly) throw new Error(`write (${op}) in a read-only transaction`); };
    const tx = {
      async get(ref) { return ref.kind === "doc" ? snapshot(ref)
        : { docs: [...table(ref.collection)].filter(([, value]) => ref.filters.every((f) => matches(value, f))).slice(0, ref.max).map(([id]) => snapshot(docRef(ref.collection, id))) }; },
      async getAll(...refs) { if (refs.at(-1)?.fieldMask) refs.pop(); return refs.map(snapshot); },
      create(ref, value) { guard("create"); buffer.push(["create", ref, value]); return tx; },
      set(ref, value) { guard("set"); buffer.push(["set", ref, value]); return tx; },
      update(ref, value) { guard("update"); buffer.push(["update", ref, value]); return tx; },
      delete(ref) { guard("delete"); buffer.push(["delete", ref]); return tx; },
    };
    const result = await callback(tx);
    if (!readOnly && failOn && writeTransactions === failOn) throw new Error("simulated commit failure (network outage)");
    for (const [op, ref] of buffer) {
      const exists = table(ref.collection).has(ref.id);
      if (op === "create" && exists) throw new Error(`ALREADY_EXISTS ${ref.path}`);
      if (op === "update" && !exists) throw new Error(`NOT_FOUND ${ref.path}`);
    }
    for (const [op, ref, value] of buffer) {
      if (op === "delete") table(ref.collection).delete(ref.id);
      else table(ref.collection).set(ref.id, op === "update" ? { ...table(ref.collection).get(ref.id), ...clone(value) } : clone(value));
      applied.push(`${op} ${ref.path}`);
    }
    return result;
  }

  return { projectId, databaseId, collection: (name) => query(name), runTransaction,
    seed: (collection, id, value) => table(collection).set(id, clone(value)),
    read: (collection, id) => clone(table(collection).get(id)), ids: (collection) => [...table(collection).keys()],
    failWriteTransaction: (n) => { failOn = n; }, get appliedWrites() { return [...applied]; } };
}

module.exports = { createMemoryFirestore };
