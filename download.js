const axios = require('axios');

/**
 * Extracts the YouTube video ID from a given URL.
 * Supports youtu.be, youtube.com, and YouTube Shorts (/shorts/VIDEO_ID).
 * @param {string} url - The YouTube URL.
 * @returns {string|null} - The video ID or null if not found.
 */
function extractVideoId(url) {
  try {
    // Prepend "https://" if the URL doesn't start with a valid protocol.
    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
    }
    const urlObj = new URL(url);
    if (urlObj.pathname.includes('/shorts/')) {
      const parts = urlObj.pathname.split('/');
      const shortsIndex = parts.indexOf('shorts');
      if (shortsIndex !== -1 && parts[shortsIndex + 1]) {
        return parts[shortsIndex + 1];
      }
    }
    if (urlObj.hostname === 'youtu.be') {
      return urlObj.pathname.slice(1);
    }
    if (urlObj.hostname.includes('youtube.com')) {
      return urlObj.searchParams.get('v');
    }
    return null;
  } catch (error) {
    console.error('שגיאה בחילוץ מזהה הווידאו:', error);
    return null;
  }
}


/**
 * Sleeps for a given number of milliseconds.
 * @param {number} ms - Milliseconds to sleep.
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Creates a text-based progress bar.
 * Example: 40% -> [████░░░░░░] 40%
 */
function createProgressBar(progress) {
  const totalBars = 10;
  const filledBars = Math.round((progress / 100) * totalBars);
  const barStr = '█'.repeat(filledBars) + '░'.repeat(totalBars - filledBars);
  return `[${barStr}] ${progress}%`;
}

/**
 * Polls the RapidAPI endpoint until a valid conversion link is available.
 * Also checks for cancellation via cancellationCheck.
 *
 * @param {string} videoId - The YouTube video ID.
 * @param {object} options - Axios request options.
 * @param {Function} updateCallback - Callback to update status.
 * @param {number} maxAttempts - Maximum polling attempts.
 * @param {number} delayMs - Delay between attempts in ms.
 * @param {number} maxQueueCount - Maximum allowed consecutive "in queue" responses.
 * @param {Function} [cancellationCheck] - Function that returns true if the download was canceled.
 * @returns {Promise<{ link: string, title: string }>}
 */
async function pollForLink(videoId, options, updateCallback, maxAttempts = 20, delayMs = 5000, maxQueueCount = 5, cancellationCheck) {
  let lastStatus = '';
  let queueCount = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (cancellationCheck && cancellationCheck()) {
      throw new Error('הורדה בוטלה על ידי המשתמש');
    }
    await sleep(delayMs);
    try {
      const pollResponse = await axios.request(options);
      const progressValue = pollResponse.data.progress || Math.min(100, Math.round((attempt / maxAttempts) * 100));
      lastStatus = pollResponse.data.msg || '';
      const status = (pollResponse.data.status || "").toLowerCase();
      
      if (lastStatus.toLowerCase().includes("in queue")) {
        queueCount++;
      } else {
        queueCount = 0;
      }
      
      const shortStatus = lastStatus.length > 100 ? lastStatus.substring(0, 100) + '...' : lastStatus;
      await updateCallback(`ממיר...\n${createProgressBar(progressValue)}\nסטטוס: ${shortStatus}`);
      
      if (status === 'fail') {
        throw new Error(pollResponse.data.msg);
      }
      
      if (pollResponse.data.link && pollResponse.data.link !== '') {
        return { link: pollResponse.data.link, title: pollResponse.data.title };
      }
      
      if (queueCount >= maxQueueCount) {
        throw new Error("Conversion stuck in queue");
      }
    } catch (pollError) {
      console.error('Error polling RapidAPI:', pollError.message);
      await updateCallback(`שגיאה בעדכון סטטוס: ${pollError.message}`);
      throw pollError;
    }
  }
  throw new Error(`לא נוצר קישור לאחר ${maxAttempts} ניסיונות. סטטוס אחרון: ${lastStatus}`);
}

/**
 * Downloads audio/video from a YouTube URL via RapidAPI.
 * For MP3 conversions, uses the youtube-mp36 endpoint.
 * For MP4 conversions, uses the youtube-video-fast-downloader-24-7 API.
 * Accepts an optional cancellationCheck callback.
 *
 * @param {string} videoUrl - The YouTube video URL.
 * @param {Function} updateCallback - Callback for status updates.
 * @param {string} [format='mp3'] - The desired format ("mp3" or "mp4").
 * @param {string|null} [quality=null] - For MP4, the desired quality id.
 * @param {Function} [cancellationCheck] - Function to check for cancellation.
 * @returns {Promise<{ link: string, title: string }>}
 */
async function processDownload(videoUrl, updateCallback, format = 'mp3', quality = null, cancellationCheck) {
  const videoId = extractVideoId(videoUrl);
  if (!videoId) {
    throw new Error('קישור YouTube לא תקין');
  }
  
  if (format === 'mp3') {
    const endpoint = 'https://youtube-mp36.p.rapidapi.com/dl';
    const host = process.env.RAPIDAPI_HOST || 'youtube-mp36.p.rapidapi.com';
    const options = {
      method: 'GET',
      url: endpoint,
      params: { id: videoId },
      headers: {
        'x-rapidapi-key': process.env.RAPIDAPI_KEY,
        'x-rapidapi-host': host,
      },
    };
    
    try {
      const response = await axios.request(options);
      const status = (response.data.status || "").toLowerCase();
      if (status === 'fail') {
        await updateCallback(`ממיר...\n${createProgressBar(response.data.progress || 0)}\nסטטוס: ${response.data.msg}`);
        throw new Error(response.data.msg);
      }
      
      if (status === 'ok' && response.data.link && response.data.link !== '') {
        return { link: response.data.link, title: response.data.title };
      }
      
      if (status === 'processing') {
        return await pollForLink(videoId, options, updateCallback, 40, 5000, 20, cancellationCheck);
      }
      
      throw new Error(`תגובה לא צפויה מ-RapidAPI: ${JSON.stringify(response.data)}`);
    } catch (error) {
      console.error('RapidAPI error:', error.message);
      if (updateCallback) {
        await updateCallback(`שגיאה: ${error.message}`);
      }
      throw error;
    }
  } else if (format === 'mp4') {
    const endpoint = `https://youtube-video-fast-downloader-24-7.p.rapidapi.com/download_video/${videoId}`;
    const qualityParam = quality || process.env.DEFAULT_VIDEO_QUALITY_ID || 137;
    const options = {
      method: 'GET',
      url: endpoint,
      params: { quality: qualityParam },
      headers: {
        'x-rapidapi-key': process.env.RAPIDAPI_KEY,
        'x-rapidapi-host': 'youtube-video-fast-downloader-24-7.p.rapidapi.com',
      },
    };
    
    try {
      // Try an initial request.
      let response = await axios.request(options);
      let fileUrl = response.data.file;
      
      // If fileUrl is not available, poll and simulate progress.
      let attempts = 0;
      while ((!fileUrl || fileUrl === "") && attempts < 20) {
        if (cancellationCheck && cancellationCheck()) {
          throw new Error('הורדה בוטלה על ידי המשתמש');
        }
        await sleep(3000); // poll more frequently
        const simulatedProgress = Math.min(100, Math.round((attempts / 20) * 100));
        await updateCallback(`ממיר...\n${createProgressBar(simulatedProgress)}\nניסיון ${attempts + 1}`);
        response = await axios.request(options);
        fileUrl = response.data.file;
        attempts++;
      }
      if (!fileUrl || fileUrl === "") {
        throw new Error(`לא נוצר קישור להורדה לאחר ${attempts} ניסיונות.`);
      }
      // Check cancellation one more time before proceeding.
      if (cancellationCheck && cancellationCheck()) {
        throw new Error('הורדה בוטלה על ידי המשתמש');
      }
      // Update progress to complete.
      await updateCallback(`ממיר...\n${createProgressBar(100)}\nסטטוס: הקובץ מוכן`, false);
      await sleep(1000); // short delay for UI update
      
      // Get video info.
      const infoOptions = {
        method: 'GET',
        url: `https://youtube-video-fast-downloader-24-7.p.rapidapi.com/get-video-info/${videoId}`,
        headers: {
          'x-rapidapi-key': process.env.RAPIDAPI_KEY,
          'x-rapidapi-host': 'youtube-video-fast-downloader-24-7.p.rapidapi.com',
        },
      };
      const infoResponse = await axios.request(infoOptions);
      const title = infoResponse.data.title || 'No Title';
      return { link: fileUrl, title };
    } catch (error) {
      console.error('RapidAPI error:', error.message);
      if (updateCallback) {
        await updateCallback(`שגיאה: ${error.message}`);
      }
      throw error;
    }
  } else {
    throw new Error("Unsupported format. Use 'mp3' or 'mp4'.");
  }
}

module.exports = {
  processDownload,
  extractVideoId,
  createProgressBar,
  sleep,
};
