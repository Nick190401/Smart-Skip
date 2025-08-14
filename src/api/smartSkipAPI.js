/**
 * Smart Skip AI API Client
 * Handles communication with the centralized AI learning database
 */

class SmartSkipAPI {
  constructor() {
    this.baseUrl = 'YOUR_API_URL'; // TODO: Replace with your actual API URL
    this.apiKey = null; // Optional API key for rate limiting
    this.sessionId = this.generateSessionId();
    this.retryAttempts = 3;
    this.requestQueue = [];
    this.isOnline = navigator.onLine;
    this.offlineBuffer = [];
    this.enabled = true; // Can be disabled via settings
    
    // Initialize online/offline detection
    this.initNetworkDetection();
    
    console.log('[Smart Skip API] 🌐 API Client initialized', {
      baseUrl: this.baseUrl,
      sessionId: this.sessionId,
      isOnline: this.isOnline
    });
  }
  
  /**
   * Generate anonymous session ID for user tracking
   */
  generateSessionId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substr(2, 9);
    const hash = btoa(`${timestamp}-${random}`).replace(/[+=\/]/g, '').substr(0, 32);
    return hash;
  }
  
  /**
   * Initialize network status detection
   */
  initNetworkDetection() {
    window.addEventListener('online', () => {
      console.log('[Smart Skip API] 🌐 Connection restored - processing offline buffer');
      this.isOnline = true;
      this.processOfflineBuffer();
    });
    
    window.addEventListener('offline', () => {
      console.log('[Smart Skip API] 📡 Connection lost - buffering requests');
      this.isOnline = false;
    });
  }
  
  /**
   * Create video fingerprint from video characteristics
   */
  async createVideoFingerprint(videoElement) {
    if (!videoElement) return null;
    
    try {
      const characteristics = {
        duration: Math.round(videoElement.duration || 0),
        videoWidth: videoElement.videoWidth || 0,
        videoHeight: videoElement.videoHeight || 0,
        currentSrc: this.anonymizeUrl(videoElement.currentSrc || ''),
        platform: this.detectPlatform(window.location.hostname)
      };
      
      // Create SHA256-like hash from characteristics
      const hashInput = JSON.stringify(characteristics);
      const hash = await this.simpleHash(hashInput);
      
      console.log('[Smart Skip API] 🎬 Created video fingerprint', {
        hash: hash.substr(0, 16) + '...',
        platform: characteristics.platform,
        duration: characteristics.duration
      });
      
      return {
        hash,
        platform: characteristics.platform,
        duration: characteristics.duration,
        metadata: {
          resolution: `${characteristics.videoWidth}x${characteristics.videoHeight}`,
          source: characteristics.currentSrc ? 'url' : 'unknown'
        }
      };
    } catch (error) {
      console.warn('[Smart Skip API] ❌ Failed to create video fingerprint:', error);
      return null;
    }
  }
  
  /**
   * Anonymize URL for privacy
   */
  anonymizeUrl(url) {
    if (!url) return '';
    
    try {
      const urlObj = new URL(url);
      return urlObj.hostname; // Only keep domain
    } catch {
      return 'unknown';
    }
  }
  
  /**
   * Detect platform from hostname
   */
  detectPlatform(hostname) {
    if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) return 'youtube';
    if (hostname.includes('netflix.com')) return 'netflix';
    if (hostname.includes('disney')) return 'disney';
    if (hostname.includes('amazon')) return 'amazon';
    if (hostname.includes('hulu')) return 'hulu';
    return 'other';
  }
  
  /**
   * Simple hash function (placeholder for crypto.subtle.digest)
   */
  async simpleHash(text) {
    if (crypto && crypto.subtle) {
      try {
        const encoder = new TextEncoder();
        const data = encoder.encode(text);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      } catch (error) {
        console.warn('[Smart Skip API] Using fallback hash function');
      }
    }
    
    // Fallback hash function
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(16).padStart(16, '0');
  }
  
  /**
   * Send prediction data to database
   */
  async submitPrediction(videoFingerprint, prediction, features) {
    const predictionData = {
      video_hash: videoFingerprint.hash,
      platform: videoFingerprint.platform,
      duration_seconds: videoFingerprint.duration,
      video_metadata: videoFingerprint.metadata,
      timestamp_seconds: Math.round(features.timestamp || 0),
      content_type: prediction.type,
      confidence_score: prediction.confidence,
      prediction_quality: this.mapQualityLevel(prediction.confidence),
      audio_features: features.audio,
      visual_features: features.visual,
      context_features: features.context,
      reasoning: prediction.reasoning,
      suggested_action: prediction.suggestedAction,
      user_session_id: this.sessionId,
      extension_version: chrome.runtime.getManifest()?.version || '2.0.0'
    };
    
    console.log('[Smart Skip API] 📤 Submitting prediction to database', {
      type: prediction.type,
      confidence: (prediction.confidence * 100).toFixed(1) + '%',
      timestamp: predictionData.timestamp_seconds + 's',
      dataSize: JSON.stringify(predictionData).length + ' bytes'
    });
    
    if (!this.isOnline) {
      this.offlineBuffer.push({ type: 'prediction', data: predictionData });
      console.log('[Smart Skip API] 📦 Buffered prediction for later submission');
      return { success: false, buffered: true };
    }
    
    try {
      const response = await this.makeRequest('/predictions', 'POST', predictionData);
      
      console.log('[Smart Skip API] ✅ Prediction submitted successfully', {
        predictionId: response.id,
        videoFingerprintId: response.video_fingerprint_id
      });
      
      return { success: true, data: response };
    } catch (error) {
      console.error('[Smart Skip API] ❌ Failed to submit prediction:', error);
      
      // Buffer for retry if it's a network error
      if (error.message.includes('fetch') || error.message.includes('network')) {
        this.offlineBuffer.push({ type: 'prediction', data: predictionData });
      }
      
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Record user action (skip/watch)
   */
  async submitUserAction(videoFingerprint, action, timestamp, predictionId = null) {
    const actionData = {
      video_hash: videoFingerprint.hash,
      timestamp_seconds: Math.round(timestamp),
      action_type: action.type, // 'manual_skip', 'auto_skip', 'watch', etc.
      action_value: action.value || null, // Skip duration, seek position, etc.
      prediction_id: predictionId,
      user_session_id: this.sessionId,
      client_timestamp: new Date().toISOString()
    };
    
    console.log('[Smart Skip API] 👤 Submitting user action', {
      action: action.type,
      timestamp: timestamp.toFixed(1) + 's',
      predictionId: predictionId || 'none'
    });
    
    if (!this.isOnline) {
      this.offlineBuffer.push({ type: 'action', data: actionData });
      return { success: false, buffered: true };
    }
    
    try {
      const response = await this.makeRequest('/user-actions', 'POST', actionData);
      console.log('[Smart Skip API] ✅ User action submitted successfully');
      return { success: true, data: response };
    } catch (error) {
      console.error('[Smart Skip API] ❌ Failed to submit user action:', error);
      this.offlineBuffer.push({ type: 'action', data: actionData });
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Get shared learning data for video
   */
  async getSharedLearningData(videoFingerprint, contentType = null) {
    const params = new URLSearchParams({
      video_hash: videoFingerprint.hash,
      limit: '100' // Limit results for performance
    });
    
    if (contentType) {
      params.append('content_type', contentType);
    }
    
    console.log('[Smart Skip API] 🔍 Fetching shared learning data', {
      videoHash: videoFingerprint.hash.substr(0, 16) + '...',
      contentType: contentType || 'all'
    });
    
    try {
      const response = await this.makeRequest(`/learning-data?${params}`, 'GET');
      
      console.log('[Smart Skip API] ✅ Retrieved shared learning data', {
        predictions: response.predictions?.length || 0,
        audioFingerprints: response.audio_fingerprints?.length || 0,
        visualPatterns: response.visual_patterns?.length || 0,
        statistics: response.statistics
      });
      
      return { success: true, data: response };
    } catch (error) {
      console.warn('[Smart Skip API] ⚠️ Failed to fetch shared learning data:', error);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Get global AI statistics
   */
  async getGlobalStatistics() {
    try {
      const response = await this.makeRequest('/statistics/global', 'GET');
      
      console.log('[Smart Skip API] 📊 Retrieved global statistics', {
        totalPredictions: response.total_predictions,
        accuracyRate: response.overall_accuracy,
        activeUsers: response.active_users_24h
      });
      
      return { success: true, data: response };
    } catch (error) {
      console.warn('[Smart Skip API] ⚠️ Failed to fetch global statistics:', error);
      return { success: false, error: error.message };
    }
  }
  
  /**
   * Process offline buffer when connection restored
   */
  async processOfflineBuffer() {
    if (this.offlineBuffer.length === 0) return;
    
    console.log(`[Smart Skip API] 🔄 Processing ${this.offlineBuffer.length} buffered requests`);
    
    const buffer = [...this.offlineBuffer];
    this.offlineBuffer = [];
    
    for (const item of buffer) {
      try {
        if (item.type === 'prediction') {
          await this.makeRequest('/predictions', 'POST', item.data);
        } else if (item.type === 'action') {
          await this.makeRequest('/user-actions', 'POST', item.data);
        }
        
        console.log(`[Smart Skip API] ✅ Processed buffered ${item.type}`);
      } catch (error) {
        console.warn(`[Smart Skip API] ❌ Failed to process buffered ${item.type}:`, error);
        // Re-add to buffer if still failing
        this.offlineBuffer.push(item);
      }
    }
  }
  
  /**
   * Make HTTP request with retry logic
   */
  async makeRequest(endpoint, method = 'GET', data = null) {
    const url = `${this.baseUrl}${endpoint}`;
    
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': `SmartSkip-Extension/${chrome.runtime.getManifest()?.version || '2.0.0'}`
      }
    };
    
    if (this.apiKey) {
      options.headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    
    if (data && method !== 'GET') {
      options.body = JSON.stringify(data);
    }
    
    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
        console.log(`[Smart Skip API] 🌐 ${method} ${endpoint} (attempt ${attempt}/${this.retryAttempts})`);
        
        const response = await fetch(url, options);
        
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const result = await response.json();
        console.log(`[Smart Skip API] ✅ Request successful`);
        return result;
        
      } catch (error) {
        console.warn(`[Smart Skip API] ⚠️ Request attempt ${attempt} failed:`, error.message);
        
        if (attempt === this.retryAttempts) {
          throw error;
        }
        
        // Exponential backoff
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  /**
   * Map confidence score to quality level
   */
  mapQualityLevel(confidence) {
    if (confidence >= 0.8) return 'excellent';
    if (confidence >= 0.6) return 'good';
    if (confidence >= 0.4) return 'learning';
    if (confidence >= 0.2) return 'uncertain';
    return 'very_low';
  }
  
  /**
   * Enable/disable API integration
   */
  setEnabled(enabled) {
    this.enabled = enabled;
    console.log(`[Smart Skip API] ${enabled ? '✅ Enabled' : '⏸️ Disabled'} database integration`);
  }
  
  /**
   * Get API status
   */
  getStatus() {
    return {
      isOnline: this.isOnline,
      sessionId: this.sessionId,
      offlineBufferSize: this.offlineBuffer.length,
      baseUrl: this.baseUrl,
      enabled: this.enabled !== false
    };
  }
}

// Export for use in AI Content Detector
window.SmartSkipAPI = SmartSkipAPI;

console.log('[Smart Skip API] 🚀 SmartSkipAPI class loaded and ready');
