// 🔍 VECTOR PIPELINE VERIFICATION
// Run: node scripts/verifyVectorIndex.js
//
// Checks the three places an embedding dimension lives and tells you if they
// disagree. A mismatch means Atlas $vectorSearch silently returns nothing and
// Path A (instant answers) is dead without any error in the logs.
//   1. Dimensions of embeddings actually stored on AnswerCards
//   2. Dimension the Atlas vector index expects
//   3. Dimension the Python embedding service currently produces

import mongoose from 'mongoose';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  let stored = null, indexDims = null, liveDims = null;

  console.log('🔌 Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGO_URI);
  const col = mongoose.connection.db.collection('answercards');

  // 1. Stored embedding dimensions (group by length — should be exactly ONE)
  const lens = await col.aggregate([
    { $match: { embedding: { $exists: true, $type: 'array' } } },
    { $project: { len: { $size: '$embedding' } } },
    { $group: { _id: '$len', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]).toArray();

  if (lens.length === 0) {
    console.log('\n❌ No AnswerCards have embeddings at all. Path A has nothing to search.');
  } else {
    console.log('\n📦 Stored embedding dimensions:');
    lens.forEach(l => console.log(`   ${l._id} dims → ${l.count} cards`));
    if (lens.length > 1) {
      console.log('   🔴 MIXED DIMENSIONS — cards from an old embedding model are unsearchable. Re-embed them.');
    }
    stored = lens[0]._id;
  }

  // 2. Atlas vector index definition
  try {
    const indexes = await col.listSearchIndexes().toArray();
    const vec = indexes.find(i => i.name === 'vector_index');
    if (!vec) {
      console.log('\n❌ No search index named "vector_index" on answercards. $vectorSearch will fail.');
      console.log(`   Found: ${indexes.map(i => i.name).join(', ') || '(none)'}`);
    } else {
      const fields = vec.latestDefinition?.fields || vec.definition?.fields || [];
      const embField = fields.find(f => f.path === 'embedding');
      indexDims = embField?.numDimensions ?? null;
      console.log(`\n🗂️  Atlas "vector_index": ${indexDims ?? '?'} dims, similarity=${embField?.similarity ?? '?'}, status=${vec.status ?? '?'}`);
    }
  } catch (err) {
    console.log(`\n⚠️ Could not list search indexes (${err.message}).`);
    console.log('   Check manually: Atlas UI → answercards → Search Indexes → vector_index → numDimensions');
  }

  // 3. Live embedding service output
  const url = process.env.PYTHON_ENGINE_URL || 'http://127.0.0.1:8000';
  try {
    const r = await axios.post(`${url}/embed`, { text: 'how to crack amazon sde internship' }, { timeout: 5000 });
    const v = r.data?.embedding;
    liveDims = Array.isArray(v) ? v.length : null;
    console.log(`\n🐍 Embedding service (${url}): ${liveDims ?? 'INVALID RESPONSE'} dims`);
  } catch (err) {
    console.log(`\n❌ Embedding service unreachable at ${url} (${err.message}).`);
    console.log('   Every question is silently skipping Path A right now.');
  }

  // Verdict
  console.log('\n══════════ VERDICT ══════════');
  const dims = [['stored cards', stored], ['atlas index', indexDims], ['live service', liveDims]]
    .filter(([, d]) => d != null);
  const unique = [...new Set(dims.map(([, d]) => d))];
  if (dims.length < 2) {
    console.log('⚠️ Not enough data points to compare — fix the errors above first.');
  } else if (unique.length === 1) {
    console.log(`✅ All consistent at ${unique[0]} dims. Path A pipeline is dimensionally sound.`);
  } else {
    console.log('🔴 DIMENSION MISMATCH — Path A is broken:');
    dims.forEach(([name, d]) => console.log(`   ${name}: ${d} dims`));
    console.log('   Fix: make the Atlas index numDimensions match the live service,');
    console.log('   then re-embed any cards stored with the wrong model.');
  }

  await mongoose.disconnect();
}

main().catch(err => { console.error('❌ Verification failed:', err); process.exit(1); });
