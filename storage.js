// =====================================================================
//  Storage for cars and their pictures.
//  - MONGODB_URI set  → MongoDB (survives restarts — use this on Render)
//  - otherwise        → files in data/ (fine on your PC, wiped on Render)
//  Both expose the same async API.
// =====================================================================
const fs = require('fs');
const path = require('path');

function fileStore(dir) {
  const carsFile = path.join(dir, 'cars.json');
  const imgDir = path.join(dir, 'images');
  fs.mkdirSync(imgDir, { recursive: true });
  let cars = fs.existsSync(carsFile) ? JSON.parse(fs.readFileSync(carsFile, 'utf8')) : [];

  const save = () => {
    const tmp = `${carsFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cars, null, 2));
    fs.renameSync(tmp, carsFile);
  };
  const imgPath = (id) => path.join(imgDir, `${id}.bin`);

  return {
    kind: 'file',
    persistent: false,
    async list() { return cars.map((c) => ({ ...c })); },
    async get(id) { const c = cars.find((x) => x.id === id); return c ? { ...c } : null; },
    async insert(car) { cars.push(car); save(); return { ...car }; },
    async update(id, patch) {
      const c = cars.find((x) => x.id === id);
      if (!c) return null;
      Object.assign(c, patch);
      save();
      return { ...c };
    },
    async remove(id) {
      const before = cars.length;
      cars = cars.filter((x) => x.id !== id);
      save();
      fs.rmSync(imgPath(id), { force: true });
      return cars.length < before;
    },
    async putImage(id, buf) { fs.writeFileSync(imgPath(id), buf); },
    async getImage(id) {
      try { return fs.readFileSync(imgPath(id)); } catch { return null; }
    },
  };
}

async function mongoStore(uri) {
  const { MongoClient, Binary } = require('mongodb');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  const db = client.db('justice_town_cars');
  const carsCol = db.collection('cars');
  const imgCol = db.collection('images');
  const noId = { projection: { _id: 0 } };

  return {
    kind: 'mongo',
    persistent: true,
    async list() { return carsCol.find({}, noId).toArray(); },
    async get(id) { return carsCol.findOne({ id }, noId); },
    async insert(car) { await carsCol.insertOne({ ...car }); return car; },
    async update(id, patch) {
      return carsCol.findOneAndUpdate({ id }, { $set: patch }, { returnDocument: 'after', ...noId });
    },
    async remove(id) {
      const r = await carsCol.deleteOne({ id });
      await imgCol.deleteOne({ _id: id });
      return r.deletedCount > 0;
    },
    async putImage(id, buf) {
      await imgCol.replaceOne({ _id: id }, { _id: id, data: new Binary(buf) }, { upsert: true });
    },
    async getImage(id) {
      const doc = await imgCol.findOne({ _id: id });
      return doc ? Buffer.from(doc.data.buffer) : null;
    },
  };
}

async function openStorage({ mongoUri, dataDir }) {
  if (mongoUri) return mongoStore(mongoUri);
  return fileStore(dataDir);
}

module.exports = { openStorage };
