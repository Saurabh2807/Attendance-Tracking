// Vercel Speed Insights Integration
// This script initializes Vercel Speed Insights for the attendance tracking app

(function() {
    'use strict';
    
    // Initialize Speed Insights queue
    window.si = window.si || function () { 
        (window.siq = window.siq || []).push(arguments); 
    };
    
    // Create and inject the Speed Insights script
    var script = document.createElement('script');
    script.defer = true;
    script.src = 'https://va.vercel-scripts.com/v1/speed-insights/script.js';
    
    // Optional: Add data-attributes for configuration
    // script.setAttribute('data-endpoint', 'custom-endpoint'); // if needed
    
    // Append the script to head
    document.head.appendChild(script);
    
    console.log('[Speed Insights] Initialized');
})();
