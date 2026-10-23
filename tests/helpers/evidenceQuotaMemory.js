// Transactional test double: serial commits, rollback and read-before-write discipline.
function memoryFirestore({ beforeCommit = () => {}, afterCommit = () => {} } = {}) {
  const collections = new Map();
  let queue = Promise.resolve(), active = false;
  function records(name) {
    if (!collections.has(name)) collections.set(name, new Map());
    return collections.get(name);
  }
  const db = { projectId: "demo-menro-phase2", collection(name) {
    return { doc(id) {
      return { id, path: `${name}/${id}`, collection: name,
        get: async () => ({ exists: records(name).has(id), data: () => records(name).get(id) }) };
    } };
  }, runTransaction(fn) {
    const run = async () => {
      active = true;
      const writes = [];
      const push = (ref, value, mode) => writes.push({ ref, value, mode });
      try {
        const result = await fn({
          get(ref) { if (writes.length) throw Error("Firestore reads must precede writes"); return ref.get(); },
          create: (ref, value) => push(ref, value, "create"),
          set: (ref, value) => push(ref, value, "set"),
          update: (ref, value) => push(ref, { ...records(ref.collection).get(ref.id), ...value }, "update"),
        });
        for (const { ref, mode } of writes) {
          if (mode === "create" && records(ref.collection).has(ref.id)) throw Error("already exists");
          if (mode === "update" && !records(ref.collection).has(ref.id)) throw Error("missing");
        }
        await beforeCommit(writes);
        for (const { ref, value } of writes) records(ref.collection).set(ref.id, value);
        await afterCommit(writes);
        return result;
      } finally { active = false; }
    };
    const result = queue.then(run); queue = result.catch(() => {}); return result;
  } };
  return { db, records, inTransaction: () => active };
}
module.exports = { memoryFirestore };
