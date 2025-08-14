/**
 * AI-Powered Content Detection System for Smart Skip 2.0
 * Uses machine learning techniques to detect intros, outros, and skip-worthy content
 */

class AIContentDetector {
  constructor() {
    this.isEnabled = true;
    this.confidence = 0.8; // Minimum confidence threshold
    this.learningData = new Map();
    this.audioContext = null;
    this.videoElement = null;
    this.frameAnalyzer = null;
    this.audioAnalyzer = null;
    this.lastAnalysisTime = 0; // Throttling for performance
    this.analysisInterval = null; // For cleanup
    
    // Database integration
    this.api = new window.SmartSkipAPI();
    this.currentVideoFingerprint = null;
    this.databaseEnabled = true;
    this.lastPredictionId = null;
    this.sharedLearningData = new Map(); // Cache for shared data
    
    // Neural network for pattern recognition (simplified implementation)
    this.neuralNetwork = {
      weights: new Map(),
      biases: new Map(),
      learningRate: 0.01
    };
    
    this.patterns = {
      intro: {
        audioFingerprints: new Set(),
        visualFeatures: new Set(),
        typicalDuration: [15, 90], // seconds
        skipProbability: 0.0
      },
      recap: {
        audioFingerprints: new Set(),
        visualFeatures: new Set(),
        typicalDuration: [10, 60],
        skipProbability: 0.0
      },
      credits: {
        audioFingerprints: new Set(),
        visualFeatures: new Set(),
        typicalDuration: [30, 180],
        skipProbability: 0.0
      }
    };
    
    this.init();
  }
  
  async init() {
    console.log('[AI Detector] 🚀 Initializing AI-Powered Content Detection...');
    console.log('[AI Detector] 📊 Initial configuration:', {
      enabled: this.isEnabled,
      confidence: this.confidence,
      learningDataSize: this.learningData.size,
      databaseEnabled: this.databaseEnabled
    });
    
    // Load pre-trained patterns from storage (local backup)
    console.log('[AI Detector] 📚 Loading local training data...');
    await this.loadTrainingData();
    
    // Initialize database API
    if (this.databaseEnabled) {
      console.log('[AI Detector] 🌐 Initializing database connection...');
      await this.initDatabaseIntegration();
    }
    
    // Initialize audio analysis
    console.log('[AI Detector] 🎵 Initializing audio analysis...');
    await this.initAudioAnalysis();
    
    // Initialize video frame analysis
    console.log('[AI Detector] 🎬 Initializing video frame analysis...');
    this.initVideoAnalysis();
    
    // Start monitoring
    console.log('[AI Detector] 👁️ Starting content monitoring...');
    this.startMonitoring();
    
    console.log('[AI Detector] ✅ AI Content Detection ready');
    console.log('[AI Detector] 📈 Pattern database loaded:', {
      intro: this.patterns.intro.audioFingerprints.size + this.patterns.intro.visualFeatures.size,
      recap: this.patterns.recap.audioFingerprints.size + this.patterns.recap.visualFeatures.size,
      credits: this.patterns.credits.audioFingerprints.size + this.patterns.credits.visualFeatures.size,
      sharedPatterns: this.sharedLearningData.size
    });
  }
  
  /**
   * Initialize database integration and load shared learning data
   */
  async initDatabaseIntegration() {
    try {
      console.log('[AI Detector] 🌐 Checking database connectivity...');
      
      if (!window.SmartSkipAPI) {
        console.warn('[AI Detector] ⚠️ SmartSkipAPI not available - continuing without database');
        this.databaseEnabled = false;
        return;
      }
      
      // Test connectivity by fetching global statistics
      const statsResult = await this.api.getGlobalStatistics();
      
      if (statsResult.success) {
        console.log('[AI Detector] ✅ Database connection established', {
          globalPredictions: statsResult.data.total_predictions,
          globalAccuracy: statsResult.data.overall_accuracy,
          activeUsers: statsResult.data.active_users_24h
        });
        
        this.databaseEnabled = true;
      } else {
        console.warn('[AI Detector] ⚠️ Database connection failed - using local learning only');
        this.databaseEnabled = false;
      }
    } catch (error) {
      console.warn('[AI Detector] ❌ Database initialization failed:', error);
      this.databaseEnabled = false;
    }
  }

  /**
   * Audio Analysis System
   * Detects recurring audio patterns (theme songs, sound effects)
   */
  async initAudioAnalysis() {
    try {
      console.log('[AI Detector] 🎵 Setting up audio context...');
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.audioAnalyzer = this.audioContext.createAnalyser();
      this.audioAnalyzer.fftSize = 2048;
      this.audioAnalyzer.smoothingTimeConstant = 0.3;
      
      console.log('[AI Detector] ✅ Audio analysis initialized successfully', {
        sampleRate: this.audioContext.sampleRate,
        fftSize: this.audioAnalyzer.fftSize,
        frequencyBinCount: this.audioAnalyzer.frequencyBinCount
      });
    } catch (error) {
      console.warn('[AI Detector] ❌ Audio analysis not available:', error.message);
      console.log('[AI Detector] 🔇 Continuing without audio analysis features');
    }
  }
  
  /**
   * Video Frame Analysis System
   * Detects visual patterns and scene changes
   */
  initVideoAnalysis() {
    console.log('[AI Detector] 🎬 Setting up video frame analyzer...');
    this.frameAnalyzer = {
      canvas: document.createElement('canvas'),
      context: null,
      lastFrame: null,
      sceneChanges: [],
      textDetection: true
    };

    this.frameAnalyzer.context = this.frameAnalyzer.canvas.getContext('2d');
    this.frameAnalyzer.canvas.width = 160; // Low res for performance
    this.frameAnalyzer.canvas.height = 90;
    
    console.log('[AI Detector] ✅ Video frame analysis initialized', {
      canvasSupported: !!this.frameAnalyzer.context,
      textDetection: this.frameAnalyzer.textDetection,
      resolution: `${this.frameAnalyzer.canvas.width}x${this.frameAnalyzer.canvas.height}`
    });
  }
  
  /**
   * Start monitoring current video for AI detection
   */
  startMonitoring() {
    this.findAndAttachToVideo();
    
    // Re-check for new videos periodically
    setInterval(() => {
      if (!this.videoElement || this.videoElement.paused) {
        this.findAndAttachToVideo();
      }
    }, 5000);
  }
  
  findAndAttachToVideo() {
    const videos = document.querySelectorAll('video');
    const activeVideo = Array.from(videos).find(v => 
      !v.paused && v.currentTime > 0 && v.readyState > 2
    );
    
    if (activeVideo && activeVideo !== this.videoElement) {
      this.attachToVideo(activeVideo);
    }
  }
  
  async attachToVideo(video) {
    if (this.videoElement) {
      this.detachFromVideo();
    }
    
    this.videoElement = video;
    console.log('[AI Detector] Attached to video element');
    
    // Create video fingerprint for database lookup
    if (this.databaseEnabled) {
      console.log('[AI Detector] 🎬 Creating video fingerprint for database lookup...');
      this.currentVideoFingerprint = await this.api.createVideoFingerprint(video);
      
      if (this.currentVideoFingerprint) {
        console.log('[AI Detector] ✅ Video fingerprint created:', {
          hash: this.currentVideoFingerprint.hash.substr(0, 16) + '...',
          platform: this.currentVideoFingerprint.platform,
          duration: this.currentVideoFingerprint.duration + 's'
        });
        
        // Load shared learning data for this video
        await this.loadSharedLearningData();
      }
    }
    
    // Bind methods for proper event listener handling
    this.boundPerformAIAnalysis = this.boundPerformAIAnalysis || this.performAIAnalysis.bind(this);
    this.boundOnVideoLoaded = this.boundOnVideoLoaded || this.onVideoLoaded.bind(this);
    this.boundOnVideoEnded = this.boundOnVideoEnded || this.onVideoEnded.bind(this);
    
    // Setup audio analysis
    if (this.audioContext && this.audioAnalyzer) {
      try {
        const source = this.audioContext.createMediaElementSource(video);
        source.connect(this.audioAnalyzer);
        this.audioAnalyzer.connect(this.audioContext.destination);
      } catch (error) {
        console.warn('[AI Detector] Could not connect audio analysis:', error);
      }
    }
    
    // Setup video event listeners
    video.addEventListener('timeupdate', this.boundPerformAIAnalysis);
    video.addEventListener('loadedmetadata', this.boundOnVideoLoaded);
    video.addEventListener('ended', this.boundOnVideoEnded);
    
    // Start real-time analysis
    this.startRealTimeAnalysis();
  }
  
  detachFromVideo() {
    if (this.videoElement) {
      // Remove event listeners properly
      if (this.boundPerformAIAnalysis) {
        this.videoElement.removeEventListener('timeupdate', this.boundPerformAIAnalysis);
      }
      if (this.boundOnVideoLoaded) {
        this.videoElement.removeEventListener('loadedmetadata', this.boundOnVideoLoaded);
      }
      if (this.boundOnVideoEnded) {
        this.videoElement.removeEventListener('ended', this.boundOnVideoEnded);
      }
      
      this.videoElement = null;
    }
  }
  
  /**
   * Real-time content analysis
   */
  startRealTimeAnalysis() {
    if (!this.videoElement) return;
    
    // Clear any existing interval
    if (this.analysisInterval) {
      clearInterval(this.analysisInterval);
    }
    
    this.analysisInterval = setInterval(() => {
      if (!this.videoElement || this.videoElement.paused || !this.isEnabled) {
        clearInterval(this.analysisInterval);
        return;
      }
      
      // The main analysis is now handled by timeupdate event
      // This interval is just for housekeeping and less frequent checks
      if (Math.random() < 0.1) { // Only 10% of the time for performance
        this.verboseLog('[AI Detector] Performing interval analysis check...');
      }
    }, 5000); // Every 5 seconds instead of 1 second
  }
  
  async performAIAnalysis() {
    if (!this.videoElement || !this.isEnabled) {
      console.log('[AI Detector] ⏸️ Analysis skipped - video not available or AI disabled');
      return;
    }
    
    // Throttle analysis to prevent excessive CPU usage
    const now = Date.now();
    if (this.lastAnalysisTime && (now - this.lastAnalysisTime) < 1000) {
      return; // Skip if less than 1 second since last analysis
    }
    this.lastAnalysisTime = now;
    
    const currentTime = this.videoElement.currentTime;
    const duration = this.videoElement.duration;
    
    if (!duration || currentTime < 1) {
      console.log('[AI Detector] ⏳ Analysis skipped - video not ready', { currentTime, duration });
      return; // Skip if video not ready
    }
    
    console.log('[AI Detector] 🔍 Starting AI analysis at', {
      timestamp: `${Math.floor(currentTime)}s / ${Math.floor(duration)}s`,
      progress: `${((currentTime / duration) * 100).toFixed(1)}%`
    });
    
    try {
      // Get analysis results
      console.log('[AI Detector] 🎵 Analyzing audio features...');
      const audioFeatures = await this.analyzeAudio();
      
      console.log('[AI Detector] 🎬 Analyzing visual features...');
      const visualFeatures = await this.analyzeVisualFeatures();
      
      console.log('[AI Detector] 📋 Analyzing context features...');
      const contextFeatures = this.analyzeContext(currentTime, duration);
      
      console.log('[AI Detector] 🧠 Combining features for prediction...', {
        audioFeatures: Object.keys(audioFeatures || {}).length,
        visualFeatures: Object.keys(visualFeatures || {}).length,
        contextFeatures: Object.keys(contextFeatures || {}).length
      });
      
      // Combine features for AI prediction
      const prediction = await this.predictContentType({
        audio: audioFeatures,
        visual: visualFeatures,
        context: contextFeatures,
        timestamp: currentTime
      });
      
      console.log(`[AI Detector] 🎯 Final prediction result:`, {
        type: prediction.type,
        confidence: (prediction.confidence * 100).toFixed(1) + '%',
        reasoning: prediction.reasoning,
        action: prediction.suggestedAction,
        willSave: true // Always save now
      });
      
      // Act on high-confidence predictions
      console.log(`[AI Detector] 🎯 Evaluating prediction confidence`, {
        predictionConfidence: (prediction.confidence * 100).toFixed(1) + '%',
        requiredThreshold: (this.confidence * 100).toFixed(1) + '%',
        meetsThreshold: prediction.confidence > this.confidence
      });
      
      // ALWAYS learn from predictions, even low confidence ones
      console.log(`[AI Detector] 📚 Learning from prediction (regardless of confidence)...`);
      this.updateLearningData(prediction);
      
      // Submit to database if enabled
      if (this.databaseEnabled && this.currentVideoFingerprint) {
        console.log(`[AI Detector] 🌐 Submitting prediction to shared database...`);
        await this.submitPredictionToDatabase(prediction, {
          audio: audioFeatures,
          visual: visualFeatures,
          context: contextFeatures,
          timestamp: currentTime
        });
      }
      
      if (prediction.confidence > this.confidence) {
        console.log(`[AI Detector] ✅ Confidence threshold met - processing prediction`);
        this.handleAIPrediction(prediction);
      } else {
        console.log(`[AI Detector] ⚠️ Confidence too low - ignoring prediction but still learning from it`);
      }
    } catch (error) {
      console.warn('[AI Detector] Analysis error:', error);
    }
  }
  
  /**
   * Load shared learning data from database for current video
   */
  async loadSharedLearningData() {
    if (!this.databaseEnabled || !this.currentVideoFingerprint) {
      console.log('[AI Detector] 📚 Skipping shared learning data - database disabled or no fingerprint');
      return;
    }
    
    try {
      console.log('[AI Detector] 🌐 Loading shared learning data from database...');
      const result = await this.api.getSharedLearningData(this.currentVideoFingerprint);
      
      if (result.success && result.data) {
        console.log('[AI Detector] ✅ Shared learning data loaded:', {
          predictions: result.data.predictions?.length || 0,
          audioFingerprints: result.data.audio_fingerprints?.length || 0,
          visualPatterns: result.data.visual_patterns?.length || 0,
          accuracyStats: result.data.statistics
        });
        
        // Integrate shared patterns into local patterns
        this.integrateSharedPatterns(result.data);
        
        // Cache shared data
        this.sharedLearningData.set(this.currentVideoFingerprint.hash, result.data);
        
        // Adjust confidence threshold based on shared data quality
        this.adjustConfidenceFromSharedData(result.data);
        
      } else {
        console.log('[AI Detector] 📚 No shared learning data available for this video');
      }
    } catch (error) {
      console.warn('[AI Detector] ❌ Failed to load shared learning data:', error);
    }
  }
  
  /**
   * Integrate shared patterns into local AI patterns
   */
  integrateSharedPatterns(sharedData) {
    console.log('[AI Detector] 🔗 Integrating shared patterns into local AI...');
    
    // Integrate audio fingerprints
    if (sharedData.audio_fingerprints) {
      sharedData.audio_fingerprints.forEach(fingerprint => {
        if (fingerprint.confidence_level > 0.7) { // Only high-confidence patterns
          this.patterns[fingerprint.content_type]?.audioFingerprints.add(fingerprint.fingerprint_hash);
          console.log(`[AI Detector] 🎵 Added shared audio pattern: ${fingerprint.content_type} (confidence: ${fingerprint.confidence_level})`);
        }
      });
    }
    
    // Integrate visual patterns
    if (sharedData.visual_patterns) {
      sharedData.visual_patterns.forEach(pattern => {
        if (pattern.confidence_level > 0.7) {
          this.patterns[pattern.content_type]?.visualFeatures.add(pattern.pattern_hash);
          console.log(`[AI Detector] 🎬 Added shared visual pattern: ${pattern.content_type} (confidence: ${pattern.confidence_level})`);
        }
      });
    }
    
    console.log('[AI Detector] ✅ Shared patterns integration complete');
  }
  
  /**
   * Adjust confidence threshold based on shared data quality
   */
  adjustConfidenceFromSharedData(sharedData) {
    if (!sharedData.statistics) return;
    
    // If shared data shows high accuracy, we can be more aggressive
    const avgAccuracy = sharedData.statistics.avg_accuracy || 0;
    const totalPredictions = sharedData.statistics.total_predictions || 0;
    
    if (totalPredictions > 10 && avgAccuracy > 0.8) {
      const adjustment = Math.min(0.1, (avgAccuracy - 0.8) * 0.5); // Max 10% reduction
      const newThreshold = Math.max(0.5, this.confidence - adjustment);
      
      if (newThreshold < this.confidence) {
        console.log(`[AI Detector] 📉 Lowering confidence threshold based on shared data quality`, {
          oldThreshold: (this.confidence * 100).toFixed(1) + '%',
          newThreshold: (newThreshold * 100).toFixed(1) + '%',
          sharedAccuracy: (avgAccuracy * 100).toFixed(1) + '%',
          sharedPredictions: totalPredictions
        });
        
        this.confidence = newThreshold;
      }
    }
  }
  
  /**
   * Submit prediction to shared database
   */
  async submitPredictionToDatabase(prediction, features) {
    if (!this.databaseEnabled || !this.currentVideoFingerprint) {
      console.log('[AI Detector] 🌐 Skipping database submission - disabled or no fingerprint');
      return;
    }
    
    try {
      const result = await this.api.submitPrediction(
        this.currentVideoFingerprint,
        prediction,
        features
      );
      
      if (result.success) {
        console.log('[AI Detector] ✅ Prediction submitted to database successfully', {
          predictionId: result.data?.id,
          type: prediction.type,
          confidence: (prediction.confidence * 100).toFixed(1) + '%'
        });
        
        // Store prediction ID for potential user action correlation
        this.lastPredictionId = result.data?.id;
        
        return result.data;
      } else if (result.buffered) {
        console.log('[AI Detector] 📦 Prediction buffered for offline submission');
      } else {
        console.warn('[AI Detector] ⚠️ Failed to submit prediction to database:', result.error);
      }
    } catch (error) {
      console.error('[AI Detector] ❌ Database submission error:', error);
    }
    
    return null;
  }

  /**
   * Audio pattern analysis
   */
  async analyzeAudio() {
    if (!this.audioAnalyzer) {
      console.log('[AI Detector] 🔇 Audio analysis skipped - analyzer not available');
      return null;
    }
    
    const bufferLength = this.audioAnalyzer.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    this.audioAnalyzer.getByteFrequencyData(dataArray);
    
    console.log('[AI Detector] 🎵 Processing audio data', {
      bufferLength,
      dataSize: dataArray.length,
      maxValue: Math.max(...dataArray),
      avgValue: dataArray.reduce((a, b) => a + b, 0) / dataArray.length
    });
    
    // Extract audio features
    const features = {
      energy: this.calculateAudioEnergy(dataArray),
      spectralCentroid: this.calculateSpectralCentroid(dataArray),
      tempo: await this.detectTempo(dataArray),
      silence: this.detectSilence(dataArray),
      fingerprint: this.generateAudioFingerprint(dataArray)
    };
    
    console.log('[AI Detector] 🎵 Audio features extracted', {
      energy: features.energy?.toFixed(2),
      spectralCentroid: features.spectralCentroid?.toFixed(2),
      tempo: features.tempo,
      silence: features.silence,
      fingerprintLength: features.fingerprint?.length || 0
    });
    
    return features;
  }
  
  calculateAudioEnergy(frequencyData) {
    let energy = 0;
    for (let i = 0; i < frequencyData.length; i++) {
      energy += frequencyData[i] * frequencyData[i];
    }
    return Math.sqrt(energy / frequencyData.length);
  }
  
  calculateSpectralCentroid(frequencyData) {
    let numerator = 0;
    let denominator = 0;
    
    for (let i = 0; i < frequencyData.length; i++) {
      numerator += i * frequencyData[i];
      denominator += frequencyData[i];
    }
    
    return denominator > 0 ? numerator / denominator : 0;
  }
  
  async detectTempo(frequencyData) {
    // Simplified tempo detection
    const lowFreq = frequencyData.slice(0, 32);
    const energy = lowFreq.reduce((sum, val) => sum + val, 0);
    
    // Store energy values for beat detection
    if (!this.beatDetection) {
      this.beatDetection = { energyHistory: [], lastBeat: 0 };
    }
    
    this.beatDetection.energyHistory.push(energy);
    if (this.beatDetection.energyHistory.length > 120) { // Keep 2 minutes of history
      this.beatDetection.energyHistory.shift();
    }
    
    // Simple beat detection algorithm
    const avgEnergy = this.beatDetection.energyHistory.reduce((a, b) => a + b, 0) / this.beatDetection.energyHistory.length;
    
    if (energy > avgEnergy * 1.3) { // Beat threshold
      const now = Date.now();
      const timeSinceLastBeat = now - this.beatDetection.lastBeat;
      this.beatDetection.lastBeat = now;
      
      if (timeSinceLastBeat > 200 && timeSinceLastBeat < 2000) { // Valid beat interval
        return 60000 / timeSinceLastBeat; // BPM
      }
    }
    
    return 0;
  }
  
  detectSilence(frequencyData) {
    const averageVolume = frequencyData.reduce((sum, val) => sum + val, 0) / frequencyData.length;
    return averageVolume < 10; // Silence threshold
  }
  
  generateAudioFingerprint(frequencyData) {
    // Create a simplified audio fingerprint
    const fingerprint = [];
    const chunkSize = Math.floor(frequencyData.length / 32);
    
    for (let i = 0; i < 32; i++) {
      const chunk = frequencyData.slice(i * chunkSize, (i + 1) * chunkSize);
      const avgAmplitude = chunk.reduce((sum, val) => sum + val, 0) / chunk.length;
      fingerprint.push(Math.floor(avgAmplitude / 8)); // Quantize to 32 levels
    }
    
    return fingerprint.join('');
  }
  
  /**
   * Visual pattern analysis
   */
  async analyzeVisualFeatures() {
    if (!this.videoElement || !this.frameAnalyzer) {
      console.log('[AI Detector] 📺 Visual analysis skipped - video or analyzer not available');
      return null;
    }
    
    const canvas = this.frameAnalyzer.canvas;
    const ctx = this.frameAnalyzer.context;
    
    console.log('[AI Detector] 🎬 Capturing video frame for analysis', {
      videoSize: `${this.videoElement.videoWidth}x${this.videoElement.videoHeight}`,
      canvasSize: `${canvas.width}x${canvas.height}`,
      currentTime: this.videoElement.currentTime.toFixed(2)
    });
    
    // Capture current frame
    ctx.drawImage(this.videoElement, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    
    console.log('[AI Detector] 🎬 Analyzing visual features...');
    const features = {
      brightness: this.calculateBrightness(imageData),
      contrast: this.calculateContrast(imageData),
      colorHistogram: this.generateColorHistogram(imageData),
      edgeDetection: this.detectEdges(imageData),
      textDetection: await this.detectText(imageData),
      sceneChange: this.detectSceneChange(imageData),
      dominantColors: this.getDominantColors(imageData)
    };
    
    console.log('[AI Detector] 🎬 Visual features extracted', {
      brightness: features.brightness?.toFixed(2),
      contrast: features.contrast?.toFixed(2),
      hasText: !!features.textDetection,
      sceneChangeDetected: features.sceneChange,
      dominantColorsCount: features.dominantColors?.length || 0,
      edgeCount: features.edgeDetection || 0
    });
    
    this.frameAnalyzer.lastFrame = imageData;
    return features;
  }
  
  calculateBrightness(imageData) {
    const data = imageData.data;
    let brightness = 0;
    
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      brightness += (r + g + b) / 3;
    }
    
    return brightness / (data.length / 4);
  }
  
  calculateContrast(imageData) {
    const data = imageData.data;
    const pixels = [];
    
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      pixels.push((r + g + b) / 3);
    }
    
    const mean = pixels.reduce((sum, p) => sum + p, 0) / pixels.length;
    const variance = pixels.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / pixels.length;
    
    return Math.sqrt(variance);
  }
  
  generateColorHistogram(imageData) {
    const data = imageData.data;
    const histogram = { r: new Array(256).fill(0), g: new Array(256).fill(0), b: new Array(256).fill(0) };
    
    for (let i = 0; i < data.length; i += 4) {
      histogram.r[data[i]]++;
      histogram.g[data[i + 1]]++;
      histogram.b[data[i + 2]]++;
    }
    
    return histogram;
  }
  
  detectEdges(imageData) {
    // Simplified edge detection using Sobel operator
    const data = imageData.data;
    const width = imageData.width;
    const height = imageData.height;
    let edgeCount = 0;
    
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = (y * width + x) * 4;
        
        // Get surrounding pixels
        const tl = data[((y-1) * width + (x-1)) * 4];
        const tm = data[((y-1) * width + x) * 4];
        const tr = data[((y-1) * width + (x+1)) * 4];
        const ml = data[(y * width + (x-1)) * 4];
        const mr = data[(y * width + (x+1)) * 4];
        const bl = data[((y+1) * width + (x-1)) * 4];
        const bm = data[((y+1) * width + x) * 4];
        const br = data[((y+1) * width + (x+1)) * 4];
        
        // Sobel X and Y
        const sobelX = (tr + 2*mr + br) - (tl + 2*ml + bl);
        const sobelY = (bl + 2*bm + br) - (tl + 2*tm + tr);
        const magnitude = Math.sqrt(sobelX*sobelX + sobelY*sobelY);
        
        if (magnitude > 50) edgeCount++;
      }
    }
    
    return edgeCount / (width * height);
  }
  
  async detectText(imageData) {
    // Simplified text detection - look for high contrast regions
    const edgeDensity = this.detectEdges(imageData);
    const contrast = this.calculateContrast(imageData);
    
    // Text typically has high edge density and contrast
    const textProbability = (edgeDensity * 100 + contrast / 100) / 2;
    
    return {
      hasText: textProbability > 0.3,
      probability: Math.min(textProbability, 1.0),
      regions: [] // Would implement OCR for actual text regions
    };
  }
  
  detectSceneChange(imageData) {
    if (!this.frameAnalyzer.lastFrame) return false;
    
    const current = imageData.data;
    const previous = this.frameAnalyzer.lastFrame.data;
    let difference = 0;
    
    for (let i = 0; i < current.length; i += 4) {
      const rDiff = Math.abs(current[i] - previous[i]);
      const gDiff = Math.abs(current[i + 1] - previous[i + 1]);
      const bDiff = Math.abs(current[i + 2] - previous[i + 2]);
      difference += (rDiff + gDiff + bDiff) / 3;
    }
    
    const avgDifference = difference / (current.length / 4);
    return avgDifference > 50; // Scene change threshold
  }
  
  getDominantColors(imageData) {
    const data = imageData.data;
    const colorCounts = new Map();
    
    // Sample every 4th pixel for performance
    for (let i = 0; i < data.length; i += 16) {
      const r = Math.floor(data[i] / 32) * 32;
      const g = Math.floor(data[i + 1] / 32) * 32;
      const b = Math.floor(data[i + 2] / 32) * 32;
      const color = `${r},${g},${b}`;
      
      colorCounts.set(color, (colorCounts.get(color) || 0) + 1);
    }
    
    // Get top 5 colors
    return Array.from(colorCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([color, count]) => ({
        rgb: color.split(',').map(Number),
        frequency: count
      }));
  }
  
  /**
   * Context analysis (timing, position in episode, etc.)
   */
  analyzeContext(currentTime, duration) {
    const progress = currentTime / duration;
    
    return {
      episodeProgress: progress,
      isBeginning: progress < 0.1,
      isMiddle: progress >= 0.1 && progress <= 0.85,
      isEnd: progress > 0.85,
      timeInEpisode: currentTime,
      remainingTime: duration - currentTime,
      isLikelyIntro: currentTime < 120 && progress < 0.05,
      isLikelyCredits: progress > 0.9 || (duration - currentTime) < 180
    };
  }
  
  /**
   * AI Prediction Engine
   */
  async predictContentType(features) {
    console.log('[AI Detector] 🧠 Starting content type prediction...');
    
    // Combine all features for prediction
    const prediction = {
      type: 'unknown',
      confidence: 0.0,
      reasoning: [],
      suggestedAction: 'none'
    };
    
    console.log('[AI Detector] 🧠 Running prediction algorithms...');
    
    // Rule-based predictions with confidence scoring
    const predictions = [
      await this.predictIntro(features),
      await this.predictRecap(features),
      await this.predictCredits(features),
      await this.predictAd(features)
    ];
    
    console.log('[AI Detector] 🧠 Prediction results:', predictions.map(p => ({
      type: p.type,
      confidence: (p.confidence * 100).toFixed(1) + '%',
      reasoning: p.reasoning?.length || 0
    })));
    
    // Select highest confidence prediction
    const bestPrediction = predictions.reduce((best, current) => 
      current.confidence > best.confidence ? current : best
    );
    
    console.log('[AI Detector] 🧠 Best prediction:', {
      type: bestPrediction.type,
      confidence: (bestPrediction.confidence * 100).toFixed(1) + '%',
      meetsThreshold: bestPrediction.confidence > 0.5,
      action: bestPrediction.suggestedAction
    });
    
    if (bestPrediction.confidence > 0.5) {
      Object.assign(prediction, bestPrediction);
      console.log('[AI Detector] ✅ Prediction accepted:', prediction.type);
    } else {
      console.log('[AI Detector] ⚠️ No confident prediction found (threshold: 50%)');
    }
    
    return prediction;
  }
  
  async predictIntro(features) {
    console.log('[AI Detector] 🎭 Analyzing for intro content...');
    let confidence = 0.0;
    const reasoning = [];
    
    // Context-based prediction
    if (features.context.isLikelyIntro) {
      confidence += 0.4;
      reasoning.push('Timing suggests intro period');
      console.log('[AI Detector] 🎭 Intro indicator: timing pattern (+40%)');
    }
    
    // Audio pattern matching
    if (features.audio) {
      if (features.audio.tempo > 0 && features.audio.energy > 50) {
        confidence += 0.2;
        reasoning.push('Music-like audio detected');
        console.log('[AI Detector] 🎭 Intro indicator: musical audio (+20%)', {
          tempo: features.audio.tempo,
          energy: features.audio.energy
        });
      }
      
      // Check against known intro fingerprints
      if (this.patterns.intro.audioFingerprints.has(features.audio.fingerprint)) {
        confidence += 0.3;
        reasoning.push('Matching audio fingerprint');
        console.log('[AI Detector] 🎭 Intro indicator: known audio pattern (+30%)');
      }
    }
    
    // Visual features
    if (features.visual) {
      if (features.visual.textDetection.hasText && features.visual.textDetection.probability > 0.7) {
        confidence += 0.15;
        reasoning.push('Title text detected');
      }
      
      if (features.visual.sceneChange) {
        confidence += 0.1;
        reasoning.push('Dynamic visual content');
      }
    }
    
    return {
      type: 'intro',
      confidence: Math.min(confidence, 1.0),
      reasoning,
      suggestedAction: confidence > 0.7 ? 'skip' : 'none'
    };
  }
  
  async predictRecap(features) {
    let confidence = 0.0;
    const reasoning = [];
    
    // Recaps typically appear early but after potential intro
    if (features.context.timeInEpisode > 30 && features.context.timeInEpisode < 300) {
      confidence += 0.3;
      reasoning.push('Timing suggests recap period');
    }
    
    // Audio analysis for recap indicators
    if (features.audio && features.audio.silence) {
      confidence += 0.1;
      reasoning.push('Voice-over silence patterns');
    }
    
    // Visual montage indicators
    if (features.visual && features.visual.sceneChange) {
      confidence += 0.2;
      reasoning.push('Rapid scene changes detected');
    }
    
    return {
      type: 'recap',
      confidence: Math.min(confidence, 1.0),
      reasoning,
      suggestedAction: confidence > 0.6 ? 'skip' : 'none'
    };
  }
  
  async predictCredits(features) {
    let confidence = 0.0;
    const reasoning = [];
    
    // Context-based prediction
    if (features.context.isLikelyCredits) {
      confidence += 0.5;
      reasoning.push('Timing suggests credits');
    }
    
    // Text detection for credits
    if (features.visual && features.visual.textDetection.hasText) {
      confidence += 0.3;
      reasoning.push('Text scrolling detected');
    }
    
    // Music pattern for credits
    if (features.audio && features.audio.energy > 30 && features.audio.tempo > 0) {
      confidence += 0.2;
      reasoning.push('Credits music detected');
    }
    
    return {
      type: 'credits',
      confidence: Math.min(confidence, 1.0),
      reasoning,
      suggestedAction: confidence > 0.7 ? 'skip' : 'none'
    };
  }
  
  async predictAd(features) {
    let confidence = 0.0;
    const reasoning = [];
    
    // Ads often have different audio characteristics
    if (features.audio && features.audio.energy > 80) {
      confidence += 0.2;
      reasoning.push('High energy audio (typical for ads)');
    }
    
    // Scene changes and bright colors
    if (features.visual) {
      if (features.visual.brightness > 150) {
        confidence += 0.1;
        reasoning.push('Bright visuals');
      }
      
      if (features.visual.sceneChange) {
        confidence += 0.2;
        reasoning.push('Rapid cuts');
      }
    }
    
    return {
      type: 'ad',
      confidence: Math.min(confidence, 1.0),
      reasoning,
      suggestedAction: confidence > 0.6 ? 'skip' : 'none'
    };
  }
  
  /**
   * Handle AI predictions
   */
  handleAIPrediction(prediction) {
    console.log(`[AI Detector] 🎯 High confidence prediction detected!`);
    console.log(`[AI Detector] 🎯 Type: ${prediction.type} (${Math.round(prediction.confidence * 100)}% confidence)`);
    console.log(`[AI Detector] 🎯 Reasoning:`, prediction.reasoning);
    console.log(`[AI Detector] 🎯 Suggested action: ${prediction.suggestedAction}`);
    console.log(`[AI Detector] 🎯 Video timestamp: ${this.videoElement?.currentTime.toFixed(2)}s`);
    
    // Send prediction to main skipper
    console.log(`[AI Detector] 📤 Sending prediction to main system...`);
    window.postMessage({
      type: 'ai-prediction',
      prediction: prediction,
      timestamp: this.videoElement?.currentTime || 0
    }, '*');
    
    // Note: Learning data is already updated in performAIAnalysis()
    console.log(`[AI Detector] 📚 Learning data already updated for this prediction`);
  }
  
  /**
   * Machine Learning Component
   */
  updateLearningData(prediction) {
    const key = `${prediction.type}_${Math.round(this.videoElement?.currentTime || 0)}`;
    
    // Determine prediction quality
    const qualityLabel = this.getConfidenceQuality(prediction.confidence);
    
    console.log(`[AI Detector] 📚 Learning from prediction:`, {
      key,
      type: prediction.type,
      confidence: (prediction.confidence * 100).toFixed(1) + '%',
      quality: qualityLabel,
      timestamp: this.videoElement?.currentTime?.toFixed(1) + 's',
      willTriggerAction: prediction.confidence > this.confidence
    });
    
    if (!this.learningData.has(key)) {
      this.learningData.set(key, {
        predictions: [],
        userActions: [],
        accuracy: 0,
        confidenceHistory: []
      });
      console.log(`[AI Detector] 📚 Created new learning entry for: ${key}`);
    }
    
    const entry = this.learningData.get(key);
    const newPrediction = {
      confidence: prediction.confidence,
      reasoning: prediction.reasoning,
      timestamp: Date.now(),
      quality: qualityLabel
    };
    
    entry.predictions.push(newPrediction);
    entry.confidenceHistory.push(prediction.confidence);
    
    // Calculate improving confidence trend
    if (entry.confidenceHistory.length > 1) {
      const recent = entry.confidenceHistory.slice(-3); // Last 3 predictions
      const trend = recent[recent.length - 1] > recent[0] ? 'improving' : 'stable/declining';
      console.log(`[AI Detector] 📈 Confidence trend for ${prediction.type}: ${trend}`);
    }
    
    console.log(`[AI Detector] 📚 Learning data updated`, {
      totalEntries: this.learningData.size,
      predictionsForThisType: entry.predictions.length,
      avgConfidence: (entry.confidenceHistory.reduce((a, b) => a + b, 0) / entry.confidenceHistory.length * 100).toFixed(1) + '%'
    });
    
    // Store learning data periodically
    this.saveLearningData();
  }
  
  getConfidenceQuality(confidence) {
    if (confidence >= 0.8) return '🎯 Excellent';
    if (confidence >= 0.6) return '👍 Good';
    if (confidence >= 0.4) return '📈 Learning';
    if (confidence >= 0.2) return '🤔 Uncertain';
    return '❓ Very Low';
  }
  
  recordUserAction(action, timestamp) {
    // Record when user manually skips to improve predictions
    console.log('[AI Detector] 👤 Recording user action for learning', {
      action,
      timestamp: timestamp.toFixed(2) + 's',
      context: this.videoElement ? 'video active' : 'no video'
    });
    
    const key = `user_action_${Math.round(timestamp)}`;
    this.learningData.set(key, {
      action: action,
      timestamp: timestamp,
      context: this.videoElement ? {
        currentTime: this.videoElement.currentTime,
        duration: this.videoElement.duration
      } : null
    });
    
    console.log('[AI Detector] 👤 User action saved - this will improve future predictions');
    
    // Submit to database if enabled
    if (this.databaseEnabled && this.currentVideoFingerprint) {
      this.submitUserActionToDatabase(action, timestamp);
    }
    
    // Auto-adjust confidence threshold based on learning progress
    this.autoAdjustConfidenceThreshold();
    
    this.saveLearningData();
  }
  
  /**
   * Submit user action to shared database
   */
  async submitUserActionToDatabase(action, timestamp) {
    try {
      console.log('[AI Detector] 🌐 Submitting user action to database...');
      
      const actionData = {
        type: typeof action === 'string' ? action : action.type || 'unknown',
        value: typeof action === 'object' ? action.value : null
      };
      
      const result = await this.api.submitUserAction(
        this.currentVideoFingerprint,
        actionData,
        timestamp,
        this.lastPredictionId
      );
      
      if (result.success) {
        console.log('[AI Detector] ✅ User action submitted to database successfully');
      } else if (result.buffered) {
        console.log('[AI Detector] 📦 User action buffered for offline submission');
      } else {
        console.warn('[AI Detector] ⚠️ Failed to submit user action:', result.error);
      }
    } catch (error) {
      console.error('[AI Detector] ❌ User action submission error:', error);
    }
  }
  
  autoAdjustConfidenceThreshold() {
    const totalPredictions = this.learningData.size;
    
    // Only adjust after we have some learning data
    if (totalPredictions < 10) return;
    
    // Calculate average confidence of recent predictions
    const recentPredictions = Array.from(this.learningData.values())
      .filter(entry => entry.predictions && entry.predictions.length > 0)
      .flatMap(entry => entry.predictions)
      .slice(-20); // Last 20 predictions
    
    if (recentPredictions.length === 0) return;
    
    const avgConfidence = recentPredictions.reduce((sum, p) => sum + p.confidence, 0) / recentPredictions.length;
    const highConfidencePredictions = recentPredictions.filter(p => p.confidence > 0.6).length;
    const successRate = highConfidencePredictions / recentPredictions.length;
    
    console.log('[AI Detector] 🎛️ Auto-adjusting confidence threshold', {
      totalPredictions,
      avgConfidence: (avgConfidence * 100).toFixed(1) + '%',
      successRate: (successRate * 100).toFixed(1) + '%',
      currentThreshold: (this.confidence * 100).toFixed(1) + '%'
    });
    
    // Gradually lower threshold as system improves
    if (successRate > 0.7 && avgConfidence > 0.5) {
      const newThreshold = Math.max(0.5, this.confidence - 0.05); // Lower by 5%, minimum 50%
      if (newThreshold < this.confidence) {
        this.confidence = newThreshold;
        console.log(`[AI Detector] 📉 Lowered confidence threshold to ${(this.confidence * 100).toFixed(1)}% (system improving!)`);
      }
    }
    
    // Raise threshold if too many false positives
    if (successRate < 0.3 && this.confidence < 0.9) {
      const newThreshold = Math.min(0.9, this.confidence + 0.05); // Raise by 5%, maximum 90%
      this.confidence = newThreshold;
      console.log(`[AI Detector] 📈 Raised confidence threshold to ${(this.confidence * 100).toFixed(1)}% (reducing false positives)`);
    }
  }
  
  async loadTrainingData() {
    try {
      console.log('[AI Detector] 📚 Loading local training data from storage...');
      const stored = await chrome.storage.local.get(['aiTrainingData']);
      if (stored.aiTrainingData) {
        this.learningData = new Map(stored.aiTrainingData);
        console.log(`[AI Detector] ✅ Successfully loaded ${this.learningData.size} local training samples`, {
          dataSize: JSON.stringify(stored.aiTrainingData).length + ' bytes',
          sampleTypes: this.getTrainingDataSummary()
        });
      } else {
        console.log('[AI Detector] 📚 No existing local training data found - starting fresh');
      }
    } catch (error) {
      console.error('[AI Detector] ❌ Failed to load local training data:', error);
    }
  }
  
  async saveLearningData() {
    try {
      console.log('[AI Detector] 💾 Saving local learning data to storage...');
      
      // Limit storage size (local backup only - main data is in database)
      if (this.learningData.size > 10000) { // Reduced size for local storage
        console.log('[AI Detector] 💾 Cleaning up old local data (keeping latest 5000 entries)');
        const entries = Array.from(this.learningData.entries());
        this.learningData = new Map(entries.slice(-5000)); // Keep latest 5000
      }
      
      const dataToSave = Array.from(this.learningData.entries());
      await chrome.storage.local.set({
        aiTrainingData: dataToSave
      });
      
      console.log('[AI Detector] ✅ Local learning data saved successfully', {
        entriesCount: dataToSave.length,
        storageKey: 'aiTrainingData',
        dataSize: JSON.stringify(dataToSave).length + ' bytes',
        note: 'Main data stored in shared database'
      });
    } catch (error) {
      console.error('[AI Detector] ❌ Failed to save local learning data:', error);
    }
  }
  
  /**
   * Public API
   */
  setConfidenceThreshold(threshold) {
    this.confidence = Math.max(0.1, Math.min(1.0, threshold));
  }
  
  enable() {
    this.isEnabled = true;
    this.startMonitoring();
  }
  
  disable() {
    this.isEnabled = false;
    this.detachFromVideo();
    
    // Clean up intervals
    if (this.analysisInterval) {
      clearInterval(this.analysisInterval);
      this.analysisInterval = null;
    }
  }
  
  getTrainingDataSummary() {
    const summary = { intro: 0, recap: 0, credits: 0, ad: 0, userActions: 0 };
    
    for (const [key, data] of this.learningData) {
      if (key.startsWith('intro_')) summary.intro++;
      else if (key.startsWith('recap_')) summary.recap++;
      else if (key.startsWith('credits_')) summary.credits++;
      else if (key.startsWith('ad_')) summary.ad++;
      else if (key.startsWith('user_action_')) summary.userActions++;
    }
    
    return summary;
  }

  getStatistics() {
    const summary = this.getTrainingDataSummary();
    const stats = {
      totalPredictions: this.learningData.size,
      confidenceThreshold: this.confidence,
      isActive: this.isEnabled && !!this.videoElement,
      patternsLearned: {
        intro: this.patterns.intro.audioFingerprints.size,
        recap: this.patterns.recap.audioFingerprints.size,
        credits: this.patterns.credits.audioFingerprints.size
      },
      learningDataBreakdown: summary,
      debugInfo: {
        learningDataKeys: Array.from(this.learningData.keys()).slice(0, 5), // First 5 keys
        totalDataSize: JSON.stringify(Array.from(this.learningData.entries())).length + ' bytes'
      },
      database: {
        enabled: this.databaseEnabled,
        connected: this.api ? this.api.getStatus().isOnline : false,
        currentVideo: this.currentVideoFingerprint ? {
          hash: this.currentVideoFingerprint.hash.substr(0, 16) + '...',
          platform: this.currentVideoFingerprint.platform,
          duration: this.currentVideoFingerprint.duration
        } : null,
        sharedPatternsLoaded: this.sharedLearningData.size,
        offlineBuffer: this.api ? this.api.getStatus().offlineBufferSize : 0
      }
    };
    
    console.log('[AI Detector] 📊 Current statistics:', stats);
    return stats;
  }
  
  /**
   * Enable/disable database integration
   */
  setDatabaseEnabled(enabled) {
    this.databaseEnabled = enabled;
    console.log(`[AI Detector] 🌐 Database integration ${enabled ? 'enabled' : 'disabled'}`);
    
    if (enabled && this.api) {
      this.api.setEnabled(true);
    } else if (this.api) {
      this.api.setEnabled(false);
    }
  }
  
  /**
   * Get database integration status
   */
  getDatabaseStatus() {
    return {
      enabled: this.databaseEnabled,
      apiAvailable: !!this.api,
      apiStatus: this.api ? this.api.getStatus() : null,
      currentVideoFingerprint: this.currentVideoFingerprint,
      sharedPatternsCount: this.sharedLearningData.size
    };
  }
  
  onVideoLoaded() {
    console.log('[AI Detector] New video loaded, starting fresh analysis');
    this.frameAnalyzer.lastFrame = null;
    this.frameAnalyzer.sceneChanges = [];
  }
  
  onVideoEnded() {
    console.log('[AI Detector] Video ended, saving analysis results');
    this.saveLearningData();
  }
  
  verboseLog(message) {
    // Only log if verbose mode is enabled (can be controlled by main skipper)
    if (window.__autoSkipper && window.__autoSkipper.instance && window.__autoSkipper.instance.verboseLogging) {
      console.log(message);
    }
  }
}

// Export for use in main skipper
window.AIContentDetector = AIContentDetector;
