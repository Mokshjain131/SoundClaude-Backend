import dotenv from 'dotenv';
import fetch from 'node-fetch';
import axios from 'axios';
import fs from 'fs';
import { Readable } from 'stream';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { connectToDatabase, closeConnection } from './db.js';
import { GridFSBucket, ObjectId } from 'mongodb';
import path from 'path';

dotenv.config();

// Replace Hugging Face with Google AI initialization
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const embedModel = genAI.getGenerativeModel({ model: "embedding-001" });

// URL of the song to fetch and encode
const songUrl = 'https://storage.googleapis.com/musikame-files/thefatrat-mayday-feat-laura-brehm-lyriclyrics-videocopyright-free-music.mp3';

// Sonoteller API params
const encodedParams = new URLSearchParams();
encodedParams.set('file', songUrl);

const apiUrl = 'https://sonoteller-ai1.p.rapidapi.com/lyrics_ddex';
const apiOptions = {
  method: 'POST',
  headers: {
    'x-rapidapi-key': process.env.RAPID_API_KEY,
    'x-rapidapi-host': 'sonoteller-ai1.p.rapidapi.com',
    'Content-Type': 'application/x-www-form-urlencoded'
  },
  body: encodedParams
};

async function streamToBuffer(stream) {
  const chunks = [];
  return new Promise((resolve, reject) => {
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function uploadToGridFS(buffer, filename, db) {
  const bucket = new GridFSBucket(db, { bucketName: 'songs_audio' });
  const uploadStream = bucket.openUploadStream(filename);
  const readable = new Readable();
  readable._read = () => {};
  readable.push(buffer);
  readable.push(null);
  return new Promise((resolve, reject) => {
    readable.pipe(uploadStream)
      .on('error', reject)
      .on('finish', () => resolve(uploadStream.id));
  });
}

async function getSongBuffer(url) {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(response.data);
}

async function songExists(url) {
  const db = await connectToDatabase();
  const collection = db.collection('songs');
  const song = await collection.findOne({ songUrl: url });
  return song !== null;
}

function cosineSimilarity(vecA, vecB) {
  const dot = vecA.reduce((sum, val, i) => sum + val * vecB[i], 0);
  const magA = Math.sqrt(vecA.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(vecB.reduce((sum, val) => sum + val * val, 0));
  return dot / (magA * magB);
}

async function fetchLyricsAndStore() {
  const db = await connectToDatabase();
  try {
    const exists = await songExists(songUrl);
    if (exists) {
      console.log('Song already exists in the database.');
      return;
    }

    const response = await fetch(apiUrl, apiOptions);
    const result = await response.json();

    const combinedText = [
      result.summary,
      ...Object.values(result.keywords || {}),
      ...Object.values(result['ddex moods'] || {}),
      ...Object.values(result['ddex themes'] || {})
    ].join(' ');

    // Replace Hugging Face embedding with Google's
    const embeddingResponse = await embedModel.embedContent(combinedText);
    const embedding = embeddingResponse.embedding.values;

    const songBuffer = await getSongBuffer(songUrl);
    const fileName = path.basename(songUrl);
    const gridFSId = await uploadToGridFS(songBuffer, fileName, db);

    const songData = {
      songUrl: songUrl,
      audioFileId: gridFSId,
      filename: fileName,
      language: result.language,
      language_iso: result["language-iso"],
      summary: result.summary,
      explicit: result.explicit,
      keywords: Object.values(result.keywords),
      ddex_moods: Object.values(result["ddex moods"]),
      ddex_themes: Object.values(result["ddex themes"]),
      flags: result.flags,
      embedding: embedding,  // Using Google's embedding
      created_at: new Date(),
    };

    const collection = db.collection('songs');
    const insertResult = await collection.insertOne(songData);
    console.log('Inserted song into DB with ID:', insertResult.insertedId);
  } catch (error) {
    console.error('Error in fetchLyricsAndStore:', error);
  } finally {
    await closeConnection();
  }
}

async function findSimilarSongs(queryText) {
  // Replace Hugging Face embedding with Google's
  const embeddingResponse = await embedModel.embedContent(queryText);
  const queryEmbedding = embeddingResponse.embedding.values;

  const db = await connectToDatabase();
  const collection = db.collection('songs');

  const songs = await collection.find({}).toArray();
  const similarities = songs.map(song => {
    const similarity = cosineSimilarity(queryEmbedding, song.embedding);
    return { songId: song._id, similarity, songData: song };
  });

  similarities.sort((a, b) => b.similarity - a.similarity);
  const topSongs = similarities.slice(0, 5);

  console.log('🎵 Top 5 similar songs:');
  topSongs.forEach(song => {
    console.log(`- ${song.songData.summary} | Similarity: ${song.similarity.toFixed(4)}`);
  });

  await closeConnection();
  return topSongs;
}

async function downloadSongFromGridFS(fileId, outputPath = './downloaded_song.mp3') {
  const db = await connectToDatabase();
  const bucket = new GridFSBucket(db, { bucketName: 'songs_audio' });

  return new Promise((resolve, reject) => {
    const downloadStream = bucket.openDownloadStream(new ObjectId(fileId));
    const writeStream = fs.createWriteStream(outputPath);
    downloadStream.pipe(writeStream)
      .on('error', reject)
      .on('finish', () => {
        console.log('✅ Download complete:', outputPath);
        resolve(outputPath);
      });
  });
}

// Run it
await fetchLyricsAndStore();