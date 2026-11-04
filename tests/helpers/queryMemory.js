const { memoryFirestore } = require("./evidenceQuotaMemory");
function queryMemory() {
  const memory = memoryFirestore();
  const queries = [];
  const original = memory.db.collection.bind(memory.db);
  memory.db.collection = name => {
    const snapshot = (id, row) => ({ id, exists: row !== undefined, data: () => row, ref: doc(id) });
    const doc = id => ({ ...original(name).doc(id), get: async () => snapshot(id, memory.records(name).get(id)) });
    const scalar = value => value?.toMillis ? value.toMillis() : value;
    const make = (filters = [], orders = [], max = Infinity, cursor = null, fields = null) => ({
      doc,
      where(field, op, value) { if (op !== "==") throw Error("Unsupported query operator"); return make([...filters, [field, value]], orders, max, cursor, fields); },
      orderBy(field, direction = "asc") { return make(filters, [...orders, [field, direction]], max, cursor, fields); },
      limit(value) { return make(filters, orders, value, cursor, fields); },
      startAfter(value) { return make(filters, orders, max, value, fields); },
      select(...value) { return make(filters, orders, max, cursor, value); },
      async get() {
        queries.push({ name, filters, orders, max });
        const compare = (a, b) => {
          for (const [field, direction] of orders.length ? orders : [["__name__", "asc"]]) {
            const x = scalar(field === "__name__" ? a.id : a.row[field]);
            const y = scalar(field === "__name__" ? b.id : b.row[field]);
            if (x !== y) return (x < y ? -1 : 1) * (direction === "desc" ? -1 : 1);
          }
          return 0;
        };
        let rows = [...memory.records(name)].map(([id, row]) => ({ id, row }))
          .filter(({ row }) => filters.every(([field, value]) => row[field] === value)).sort(compare);
        if (cursor) rows = rows.filter(row => compare(row, { id: cursor.id, row: cursor.data() }) > 0);
        return { docs: rows.slice(0, max).map(({ id, row }) => snapshot(id, fields ? Object.fromEntries(fields.map(field => [field, row[field]])) : row)) };
      },
    });
    return make();
  };
  return { ...memory, queries };
}
module.exports = { queryMemory };
