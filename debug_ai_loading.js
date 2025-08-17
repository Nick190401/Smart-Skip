// Debug script to test AI initialization
// Add this to the browser console to debug AI loading issues

console.log('=== Smart Skip AI Debug Test ===');

// Check if scripts are loaded
console.log('1. Checking script availability:');
console.log('   SmartSkipAPI:', typeof window.SmartSkipAPI);
console.log('   AIContentDetector:', typeof window.AIContentDetector);

// Test SmartSkipAPI instantiation
console.log('\n2. Testing SmartSkipAPI instantiation:');
try {
  if (window.SmartSkipAPI) {
    const testAPI = new window.SmartSkipAPI();
    console.log('   ✅ SmartSkipAPI instantiated successfully');
    console.log('   Status:', testAPI.getStatus());
  } else {
    console.log('   ❌ SmartSkipAPI not available');
  }
} catch (error) {
  console.log('   ❌ SmartSkipAPI instantiation failed:', error);
}

// Test AIContentDetector instantiation
console.log('\n3. Testing AIContentDetector instantiation:');
try {
  if (window.AIContentDetector) {
    const testDetector = new window.AIContentDetector();
    console.log('   ✅ AIContentDetector instantiated successfully');
    console.log('   Statistics:', testDetector.getStatistics());
  } else {
    console.log('   ❌ AIContentDetector not available');
  }
} catch (error) {
  console.log('   ❌ AIContentDetector instantiation failed:', error);
}

// Check global Smart Skip instance
console.log('\n4. Checking global Smart Skip instance:');
if (window.__autoSkipper && window.__autoSkipper.instance) {
  console.log('   ✅ Smart Skip instance found');
  console.log('   AI Enabled:', window.__autoSkipper.instance.aiEnabled);
  console.log('   AI Detector:', !!window.__autoSkipper.instance.aiDetector);
} else {
  console.log('   ❌ Smart Skip instance not found');
}

console.log('\n=== End Debug Test ===');
