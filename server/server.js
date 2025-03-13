require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { S3 } = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const { processDownload, extractVideoId } = require('./download');
const cors = require('cors');


const app = express();
const port = process.env.PORT || 3000;
app.use(bodyParser.json());

// Allow only your frontend domain in production:
if (process.env.NODE_ENV === 'development') {
  app.use(cors());
} else app.use(cors({ origin: process.env.FRONTEND_URL }));

// AWS S3 Setup.
const s3 = new S3({
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  region: process.env.AWS_REGION,
});

// In-memory job storage (jobId → job object)
const jobs = {};

// Helper to generate unique job ids.
function generateJobId() {
  return crypto.randomBytes(8).toString('hex');
}

// GET /api/ping
app.get('/api/ping', async (req, res) => {
  res.json({ message: 'pong' });
});

// POST /api/download
// Request payload: { url: string, format: 'mp3'|'mp4', quality?: number }
// Returns: { jobId }
app.post('/api/download', async (req, res) => {
  const { url, format, quality } = req.body;
  if (!url || !(url.includes('youtube.com') || url.includes('youtu.be'))) {
    return res.status(400).json({ error: 'Please provide a valid YouTube URL.' });
  }
  const videoId = extractVideoId(url);
  if (!videoId) {
    return res.status(400).json({ error: 'Could not extract video ID from URL.' });
  }
  const jobId = generateJobId();
  jobs[jobId] = {
    videoId,
    format: format || 'mp3',
    quality: quality || null,
    status: 'queued',
    progress: 0,
    result: null,
    error: null,
    cancelled: false,
  };

  // Kick off download processing asynchronously.
  (async () => {
    try {
      jobs[jobId].status = 'processing';
      // Define a function to update progress.
      const updateStatus = async (newStatus) => {
        // Update job progress (simulate progress if API does not provide)
        // Here we try to parse a progress bar from newStatus text.
        const match = newStatus.match(/\[(.*)\] (\d+)%/);
        if (match) {
          jobs[jobId].progress = parseInt(match[2], 10);
        }
        jobs[jobId].statusText = newStatus;
      };

      // Define cancellation check.
      const cancellationCheck = () => jobs[jobId].cancelled;

      const videoUrl = `https://youtu.be/${videoId}`;
      const result = await processDownload(videoUrl, updateStatus, jobs[jobId].format, jobs[jobId].quality, cancellationCheck);
      jobs[jobId].result = result;
      jobs[jobId].status = 'finished';
    } catch (error) {
      if (error.message === 'הורדה בוטלה על ידי המשתמש') {
        jobs[jobId].status = 'cancelled';
      } else {
        jobs[jobId].error = error.message;
        jobs[jobId].status = 'error';
      }
    }
  })();

  res.json({ jobId });
});

// GET /api/status/:jobId
// Returns the current status and progress for a job.
app.get('/api/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({
    status: job.status,
    progress: job.progress,
    statusText: job.statusText || '',
    result: job.result,
    error: job.error,
  });
});

// POST /api/cancel/:jobId
// Cancels an ongoing download.
app.post('/api/cancel/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status === 'finished' || job.status === 'error') {
    return res.json({ message: 'Job already completed' });
  }
  job.cancelled = true;
  job.status = 'cancelled';
  res.json({ message: 'Download cancelled by user.' });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
