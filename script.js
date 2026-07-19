// ===== DIAGNOSTICS & GLOBAL ERROR CATCHING =====
window.addEventListener('error', (e) => {
    toast(`🚨 JS Error: ${e.message} at ${e.filename}:${e.lineno}`);
    console.error("Caught JS Error:", e);
});
window.addEventListener('unhandledrejection', (e) => {
    toast(`🚨 Promise Rejection: ${e.reason}`);
    console.error("Caught Promise Rejection:", e.reason);
});

// ===== CONSTANTS & GLOBAL STATE =====
let supabaseClient = null;
let currentUser = null;
let connectionData = null;
let summaryData = [];
let logsData = [];

// App readiness and Splash screen tracking
let isAppReady = false;
let isTimerDone = false;
let isInitializing = false;
let processedUserId = undefined;
let pendingInitStep = 'none';
let isSyncInProgress = false;
let activeRefreshPromise = null;

function promiseWithTimeout(promise, timeoutMs, timeoutErrorMsg) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(timeoutErrorMsg));
        }, timeoutMs);
    });
    return Promise.race([
        promise.then(result => {
            clearTimeout(timeoutId);
            return result;
        }),
        timeoutPromise
    ]);
}

function safeRefreshSession() {
    if (activeRefreshPromise) {
        console.log('[SESSION] refreshSession is already in progress, reusing existing promise');
        return activeRefreshPromise;
    }
    if (!supabaseClient) {
        return Promise.reject(new Error("Supabase client not initialized"));
    }
    console.log('[DIAGNOSTIC] refresh promise created');
    activeRefreshPromise = supabaseClient.auth.refreshSession()
        .then(result => {
            console.log('[DIAGNOSTIC] refresh promise resolved', result);
            return result;
        })
        .catch(err => {
            console.error('[DIAGNOSTIC] refresh promise rejected', err);
            throw err;
        })
        .finally(() => {
            activeRefreshPromise = null;
        });
    return activeRefreshPromise;
}



function getCachedUser() {
    try {
        const key = Object.keys(localStorage).find(k => k.startsWith('sb-') && k.endsWith('-auth-token'));
        if (key) {
            const data = JSON.parse(localStorage.getItem(key));
            if (data && data.user) {
                return data.user;
            }
        }
    } catch (e) {
        console.error("[SESSION] Error reading cached user from localStorage:", e);
    }
    return null;
}

function showOfflineBanner(message) {
    let banner = document.getElementById('appOfflineBanner');
    if (!banner) {
        banner = document.createElement('div');
        banner.id = 'appOfflineBanner';
        banner.className = 'offline-banner';
        const header = document.querySelector('.header');
        if (header) {
            header.insertAdjacentElement('afterend', banner);
        }
    }
    const bannerText = banner.querySelector('.banner-text');
    if (bannerText) {
        bannerText.textContent = message;
    } else {
        banner.innerHTML = `⚠️ <span class="banner-text">${message}</span>`;
    }
    
    // Disable Sync actions
    disableSyncActions(true);
}

function hideOfflineBanner() {
    const banner = document.getElementById('appOfflineBanner');
    if (banner) {
        banner.remove();
    }
    // Enable Sync actions
    disableSyncActions(false);
}

function disableSyncActions(disable) {
    const syncNavBtn = document.querySelector('.ntab-sync');
    if (syncNavBtn) {
        if (disable) {
            syncNavBtn.style.opacity = '0.4';
            syncNavBtn.style.pointerEvents = 'none';
        } else {
            syncNavBtn.style.opacity = '1';
            syncNavBtn.style.pointerEvents = 'auto';
        }
    }
    const fallbackBtn = document.getElementById('dashboardFallbackBtn');
    if (fallbackBtn) {
        fallbackBtn.disabled = disable;
        fallbackBtn.style.opacity = disable ? '0.5' : '1';
    }
}

function checkAndHideSplash() {
    if (isAppReady && isTimerDone) {
        console.log("[SPLASH] Hiding splash screen.");
        const splash = document.getElementById('splashScreen');
        if (splash) {
            splash.style.opacity = '0';
            setTimeout(() => {
                splash.style.visibility = 'hidden';
            }, 500);
        }
    }
}

// Centralized initialization failure helper
function handleInitializationFailure(err) {
    console.error(`[BOOT] Initialization failed at step: ${pendingInitStep}. Error:`, err);
    
    isInitializing = false;
    isAppReady = true;
    isTimerDone = true;
    checkAndHideSplash();
    
    // Clear display blocks for app view and route back to login screen safely
    const appEl = document.getElementById('app');
    if (appEl) appEl.style.display = 'none';
    const obEl = document.getElementById('ob');
    if (obEl) {
        obEl.style.display = 'flex';
        obEl.style.flexDirection = 'column';
    }
    showAuthTab('login');
    
    toast("⚠️ Connection error or session expired. Please log in again.");
}

// ===== OFFLINE LOCAL STORAGE CACHE SYSTEM =====
function loadCachedData(userId) {
    try {
        console.log("[CACHE] Attempting to load cached user data from localStorage for:", userId);
        const cachedConn = localStorage.getItem(`ae_conn_${userId}`);
        const cachedSum = localStorage.getItem(`ae_sum_${userId}`);
        const cachedLogs = localStorage.getItem(`ae_logs_${userId}`);

        if (cachedConn) {
            connectionData = JSON.parse(cachedConn);
            console.log("[CACHE] Loaded cached connection details:", connectionData);
        }
        if (cachedSum) {
            summaryData = JSON.parse(cachedSum);
            console.log("[CACHE] Loaded cached summary data count:", summaryData.length);
        }
        if (cachedLogs) {
            logsData = JSON.parse(cachedLogs);
            console.log("[CACHE] Loaded cached logs data count:", logsData.length);
        }

        // If we have cached connection data, show the dashboard and render values immediately
        if (connectionData) {
            console.log("[CACHE] Rendering dashboard with cached data");
            showDashboardView();
            
            // Set header labels
            updateWelcomeHeader(currentUser);
            
            const lastSyncEl = document.getElementById('headerLastSync');
            if (lastSyncEl) {
                lastSyncEl.textContent = connectionData.last_sync_at ? `Last sync: ${timeAgo(connectionData.last_sync_at)}` : 'Never';
            }

            // Render cached data on UI panels
            updateSyncStatusStrip();
            renderDashboard();
            renderSubjects();
            populateHistoryFilters();
            renderHistory();
            renderInsights();
            renderSettingsPage();

            isAppReady = true;
            checkAndHideSplash();
        }
    } catch (e) {
        console.error("[CACHE] Failed to load cached user data:", e);
    }
}

function saveCachedData(userId) {
    try {
        if (!userId) return;
        if (connectionData) {
            localStorage.setItem(`ae_conn_${userId}`, JSON.stringify(connectionData));
        } else {
            localStorage.removeItem(`ae_conn_${userId}`);
        }
        if (summaryData) {
            localStorage.setItem(`ae_sum_${userId}`, JSON.stringify(summaryData));
        } else {
            localStorage.removeItem(`ae_sum_${userId}`);
        }
        if (logsData) {
            localStorage.setItem(`ae_logs_${userId}`, JSON.stringify(logsData));
        } else {
            localStorage.removeItem(`ae_logs_${userId}`);
        }
        console.log("[CACHE] Successfully saved data to localStorage");
    } catch (e) {
        console.error("[CACHE] Failed to save user data to cache:", e);
    }
}

// Unified session state handler with idempotency guard
async function handleSessionState(session) {
    const userId = session && session.user ? session.user.id : null;
    
    if (userId === processedUserId) {
        console.log(`[SESSION] User ID ${userId || 'guest'} is already processed. Skipping duplicate handler.`);
        return;
    }
    
    const previousUserId = processedUserId;
    processedUserId = userId;
    currentUser = session ? session.user : null;
    
    console.log(`[SESSION] Processing state for user ID: ${userId || 'guest'}`);
    
    if (currentUser) {
        // Load cached data from localStorage immediately to show last synced data without delay
        loadCachedData(currentUser.id);

        if (isInitializing) {
            console.log("[SESSION] Already processing initial boot check. Skipping nested load.");
            return;
        }
        isInitializing = true;
        
        try {
            pendingInitStep = 'load-user-profile';
            console.log('[ON_AUTH_STATE_CHANGE] handleSessionState: before await checkConnectionAndLoadData');
            await checkConnectionAndLoadData();
            console.log('[ON_AUTH_STATE_CHANGE] handleSessionState: after await checkConnectionAndLoadData');
            pendingInitStep = 'complete';
        } catch (err) {
            console.error("[SESSION] Error during user profile or database loading:", err);
            handleInitializationFailure(err);
        } finally {
            isInitializing = false;
        }
    } else {
        console.log("[SESSION] No active session found. Routing to Login Screen.");
        // Clear active session states and cache on logout
        if (previousUserId) {
            localStorage.removeItem(`ae_conn_${previousUserId}`);
            localStorage.removeItem(`ae_sum_${previousUserId}`);
            localStorage.removeItem(`ae_logs_${previousUserId}`);
        }
        connectionData = null;
        summaryData = [];
        logsData = [];

        pendingInitStep = 'route-to-welcome';
        showWelcomeScreen();
        // Force splash screen to hide quickly on welcome/login routing
        isAppReady = true;
        isTimerDone = true;
        checkAndHideSplash();
        pendingInitStep = 'complete';
    }
}

// OTP States
let otpSourceScreen = 'login';
let otpEmail = '';
let otpName = '';
let otpTimer = null;
let otpCountdownValue = 60;

// Navigation mapping
const DNAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ===== INIT =====
window.addEventListener('DOMContentLoaded', async () => {
    pendingInitStep = 'check-supabase-config';
    console.log('[BOOT] Application starting');
    console.log("[BOOT] DOMContentLoaded event fired.");
    
    // Light/Dark Theme Restore
    try {
        const savedTheme = localStorage.getItem('ae_theme');
        const isLight = (savedTheme === null || savedTheme === 'lm');
        if (isLight) {
            document.body.classList.add('lm');
        } else {
            document.body.classList.remove('lm');
        }
        const checkbox = document.getElementById('themeBtn');
        if (checkbox) checkbox.checked = isLight;
        console.log("[BOOT] Theme loaded.");
    } catch (e) {
        console.error("[BOOT] Failed to restore theme preference:", e);
    }

    // Splash screen minimum timer (1.5s)
    console.log("[SPLASH] Minimum timer started (1.5s).");
    setTimeout(() => {
        console.log("[SPLASH] Minimum timer completed.");
        isTimerDone = true;
        checkAndHideSplash();
    }, 1500);

    // Splash screen guaranteed timeout safety net (3s)
    console.log("[SPLASH] Safety timeout started (3s).");
    setTimeout(() => {
        if (!isAppReady) {
            console.log("[TIMEOUT] Splash timeout triggered");
            console.error(`[SPLASH] Timeout triggered. Pending Step: ${pendingInitStep}`);
            
            // Ensure timeout fallback only activates when no valid session exists, OR session restoration genuinely fails
            const sessionExists = !!currentUser;
            if (sessionExists) {
                console.log("[TIMEOUT] Session exists during safety timeout. Bypassing login redirect. Forcing app to ready.");
                console.log("[AUTH] Redirecting to dashboard");
                showDashboardView();
                isAppReady = true;
                isTimerDone = true;
                checkAndHideSplash();
            } else {
                // If getSession is hanging, check cached user as fallback
                const cachedUser = getCachedUser();
                if (cachedUser) {
                    console.log("[TIMEOUT] getSession check hung, but cached user found in localStorage. Opening offline fallback.");
                    console.log("[SESSION] Session restored from local cache (offline fallback)");
                    console.log("[SESSION] Session found");
                    console.log("[SESSION] Session restored");
                    currentUser = cachedUser;
                    processedUserId = cachedUser.id;
                    
                    console.log("[AUTH] Redirecting to dashboard");
                    showDashboardView();
                    
                    isAppReady = true;
                    isTimerDone = true;
                    checkAndHideSplash();
                    
                    // Set welcome header label
                    updateWelcomeHeader(cachedUser);
                    
                    showOfflineBanner("Offline Mode - Reconnecting...");
                } else {
                    console.log("[TIMEOUT] getSession hung and no cached user exists. Showing login screen.");
                    console.log("[SESSION] Session missing");
                    handleInitializationFailure(new Error(`Startup timed out at step: ${pendingInitStep}`));
                }
            }
        }
    }, 3000);

    // Verify Supabase Config is present
    if (!window.SUPABASE_URL || !window.SUPABASE_ANON_KEY) {
        console.error("[BOOT] Supabase configuration credentials missing in config.js!");
        toast("⚠️ Supabase config.js parameters missing!");
        showWelcomeScreen();
        return;
    }

    // Initialize Supabase
    try {
        pendingInitStep = 'init-supabase-client';
        console.log("[BOOT] Initializing Supabase client...");
        if (typeof supabase === 'undefined') {
            throw new Error("Supabase SDK is not loaded. Please check your internet connection.");
        }
        supabaseClient = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
        console.log("[BOOT] Supabase client initialized.");
        
        // Clean auth fragments from URL to prevent bookmarking sensitive/expired tokens
        if (window.location.hash && (window.location.hash.includes('access_token=') || window.location.hash.includes('error='))) {
            setTimeout(() => {
                window.history.replaceState(null, document.title, window.location.pathname + window.location.search);
            }, 100);
        }
    } catch (err) {
        console.error("[BOOT] Supabase client initialization failed:", err);
        handleInitializationFailure(err);
        return;
    }

    // OTP inputs focus shift handlers
    try {
        const otpBoxes = document.querySelectorAll('.otp-box');
        const hiddenOtpInput = document.getElementById('otpCode');

        otpBoxes.forEach((box, idx) => {
            box.addEventListener('input', (e) => {
                if (box.value.length === 1 && idx < otpBoxes.length - 1) {
                    otpBoxes[idx + 1].focus();
                }
                updateHiddenOtpValue();
            });

            box.addEventListener('keydown', (e) => {
                if (e.key === 'Backspace') {
                    if (box.value.length === 0 && idx > 0) {
                        otpBoxes[idx - 1].focus();
                        otpBoxes[idx - 1].value = '';
                    } else {
                        box.value = '';
                    }
                    updateHiddenOtpValue();
                }
            });
        });

        function updateHiddenOtpValue() {
            let code = '';
            otpBoxes.forEach(b => {
                code += b.value;
            });
            if (hiddenOtpInput) {
                hiddenOtpInput.value = code;
            }
        }
    } catch (e) {
        console.error("[BOOT] Error registering OTP focus handlers:", e);
    }

    // Setup auth state change listener
    try {
        pendingInitStep = 'restore-session';
        console.log("[AUTH] Setting up onAuthStateChange listener...");
        supabaseClient.auth.onAuthStateChange(async (event, session) => {
            console.log('[ON_AUTH_STATE_CHANGE] auth callback entered');
            console.log(`[AUTH] Auth state changed event received: ${event}`, session);
            if (session) {
                console.log("[SESSION] Session found");
                if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
                    console.log("[SESSION] Session restored");
                }
            } else {
                console.log("[SESSION] Session missing");
            }
            try {
                console.log('[ON_AUTH_STATE_CHANGE] deferring handleSessionState(session)');
                setTimeout(() => {
                    console.log('[ON_AUTH_STATE_CHANGE] inside setTimeout: calling handleSessionState(session)');
                    handleSessionState(session);
                }, 0);
            } catch (err) {
                console.error("[AUTH] Error processing auth state change event:", err);
                handleInitializationFailure(err);
            }
            console.log('[ON_AUTH_STATE_CHANGE] auth callback exited');
        });
    } catch (err) {
        console.error("[AUTH] Failed to register onAuthStateChange listener:", err);
        handleInitializationFailure(err);
        return;
    }

    // Explicitly call getSession() to handle fast session restoration
    try {
        console.log("[SESSION] getSession started");
        
        let session = null;
        let getSessionError = null;
        try {
            const res = await supabaseClient.auth.getSession();
            session = res.data?.session;
            getSessionError = res.error;
        } catch (e) {
            getSessionError = e;
        }
        
        console.log("[SESSION] getSession completed");

        // If we already timed out and forced AppReady using offline fallback, don't re-run full load unless we succeeded
        if (isAppReady && currentUser && getSessionError) {
            console.log("[SESSION] getSession failed after safety timeout. Staying in offline mode.");
            return;
        }

        if (getSessionError) {
            console.warn("[SESSION] getSession() failed or returned error:", getSessionError);
            
            // Check if it is a network error or token invalidation
            const isNetworkError = getSessionError.message && (
                getSessionError.message.toLowerCase().includes("fetch") || 
                getSessionError.message.toLowerCase().includes("network") || 
                getSessionError.message.toLowerCase().includes("load") ||
                getSessionError.message.toLowerCase().includes("timeout")
            );

            if (isNetworkError && currentUser) {
                console.log("[SESSION] Network error during getSession. Bypassing login redirect. Staying offline.");
                showOfflineBanner("Offline Mode");
                return;
            }

            throw getSessionError;
        }

        if (session) {
            console.log("[SESSION] Session found");
            console.log("[SESSION] Session restored");
            hideOfflineBanner();
            try {
                await handleSessionState(session);
            } catch (err) {
                console.error("[SESSION] Error handling manual getSession state:", err);
                handleInitializationFailure(err);
            }
        } else {
            console.log("[SESSION] Session missing");
            hideOfflineBanner();
            await handleSessionState(null);
        }
    } catch (err) {
        console.error("[SESSION] Failed to query session via getSession():", err);
        handleInitializationFailure(err);
    }
});

// ===== LIFE CYCLE RESUME: VISIBILITY CHANGE =====
document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible') {
        console.log('[LIFECYCLE] App visible, checking session validity...');
        if (!supabaseClient) return;

        let session = null;
        let getSessionStartTime = Date.now();
        console.log('[DIAGNOSTIC] getSession (visibilitychange) started');
        let getSessionTimedOutOrFailed = false;

        try {
            const res = await promiseWithTimeout(
                supabaseClient.auth.getSession(),
                5000,
                'getSession timeout'
            );
            const duration = Date.now() - getSessionStartTime;
            console.log(`[DIAGNOSTIC] getSession (visibilitychange) finished (${duration}ms)`);
            session = res.data?.session;
        } catch (err) {
            getSessionTimedOutOrFailed = true;
            const duration = Date.now() - getSessionStartTime;
            console.warn(`[DIAGNOSTIC] getSession (visibilitychange) timed out or failed after ${duration}ms:`, err);
        }

        if (getSessionTimedOutOrFailed) {
            let refreshSessionStartTime = Date.now();
            console.log('[DIAGNOSTIC] refreshSession (visibilitychange) started');
            try {
                const res = await promiseWithTimeout(
                    safeRefreshSession(),
                    8000,
                    'refreshSession timeout'
                );
                const duration = Date.now() - refreshSessionStartTime;
                console.log(`[DIAGNOSTIC] refreshSession (visibilitychange) finished (${duration}ms)`);
                session = res.data?.session;
            } catch (err) {
                const duration = Date.now() - refreshSessionStartTime;
                console.error(`[DIAGNOSTIC] refreshSession (visibilitychange) finished with error/timeout after ${duration}ms:`, err);
            }
        }

        if (session) {
            const expiresAt = session.expires_at; // in seconds
            const currentTime = Math.floor(Date.now() / 1000);
            const secondsToExpiry = expiresAt - currentTime;
            console.log(`[SESSION] Session expires in ${secondsToExpiry}s`);

            if (secondsToExpiry < 600) {
                console.log('[SESSION] Session is close to expiry or expired. Proactively refreshing...');
                let refreshSessionStartTime = Date.now();
                console.log('[DIAGNOSTIC] refreshSession (proactive) started');
                try {
                    const res = await promiseWithTimeout(
                        safeRefreshSession(),
                        8000,
                        'refreshSession timeout'
                    );
                    const duration = Date.now() - refreshSessionStartTime;
                    console.log(`[DIAGNOSTIC] refreshSession (proactive) finished (${duration}ms)`);
                    if (res.data?.session) {
                        console.log('[SESSION] Session proactively refreshed successfully');
                    } else {
                        console.warn('[SESSION] Proactive refreshSession returned no session');
                    }
                } catch (err) {
                    const duration = Date.now() - refreshSessionStartTime;
                    console.error(`[DIAGNOSTIC] refreshSession (proactive) finished with error/timeout after ${duration}ms:`, err);
                }
            } else {
                console.log('[SESSION] Session is valid for a long time. No refresh needed.');
            }
        } else {
            console.log('[SESSION] No active session found on visibility change.');
        }
    }
});


// ===== AUTHENTICATION LIFE CYCLE =====
function showWelcomeScreen() {
    document.getElementById('ob').style.display = 'flex';
    document.getElementById('ob').style.flexDirection = 'column';
    document.getElementById('app').style.display = 'none';
    showAuthTab('welcome');
    isAppReady = true;
    checkAndHideSplash();
}

function showAuthTab(tab) {
    document.querySelectorAll('.auth-section').forEach(s => s.style.display = 'none');
    if (tab === 'welcome') {
        document.getElementById('welcomeScreen').style.display = 'block';
    } else if (tab === 'login') {
        document.getElementById('loginScreen').style.display = 'block';
    } else if (tab === 'signup') {
        document.getElementById('signupScreen').style.display = 'block';
    } else if (tab === 'connect') {
        document.getElementById('connectScreen').style.display = 'block';
    } else if (tab === 'otp') {
        document.getElementById('otpScreen').style.display = 'block';
    }
}

async function handleSendSignUpOtp() {
    const name = document.getElementById('signUpName').value.trim();
    const email = document.getElementById('signUpEmail').value.trim();

    if (!name || !email) {
        toast("❌ Please fill in all fields");
        return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        toast("❌ Please enter a valid email address");
        return;
    }

    otpSourceScreen = 'signup';
    otpEmail = email;
    otpName = name;

    if (!supabaseClient) {
        toast("⚠️ Supabase service is unavailable. Please check your connection.");
        return;
    }
    toast("⏳ Sending verification code...");
    const { error } = await supabaseClient.auth.signInWithOtp({
        email,
        options: {
            data: {
                full_name: name
            }
        }
    });

    if (error) {
        toast(`❌ Failed to send code: ${error.message}`);
    } else {
        toast("✅ Code sent to your email!");
        document.getElementById('otpCode').value = '';
        showAuthTab('otp');
        document.getElementById('otpSub').textContent = `Enter the 6-digit code sent to ${email}`;
        startOtpCountdown();
    }
}

async function handleSendLoginOtp() {
    const email = document.getElementById('loginEmail').value.trim();

    if (!email) {
        toast("❌ Please enter your email");
        return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        toast("❌ Please enter a valid email address");
        return;
    }

    otpSourceScreen = 'login';
    otpEmail = email;
    otpName = '';

    if (!supabaseClient) {
        toast("⚠️ Supabase service is unavailable. Please check your connection.");
        return;
    }
    toast("⏳ Sending verification code...");
    const { error } = await supabaseClient.auth.signInWithOtp({
        email
    });

    if (error) {
        toast(`❌ Failed to send code: ${error.message}`);
    } else {
        toast("✅ Code sent to your email!");
        document.getElementById('otpCode').value = '';
        showAuthTab('otp');
        document.getElementById('otpSub').textContent = `Enter the 6-digit code sent to ${email}`;
        startOtpCountdown();
    }
}

function startOtpCountdown() {
    if (otpTimer) clearInterval(otpTimer);
    
    otpCountdownValue = 60;
    const btn = document.getElementById('resendOtpBtn');
    btn.disabled = true;
    btn.textContent = `Resend in ${otpCountdownValue}s`;

    otpTimer = setInterval(() => {
        otpCountdownValue--;
        if (otpCountdownValue <= 0) {
            clearInterval(otpTimer);
            otpTimer = null;
            btn.disabled = false;
            btn.textContent = "Resend Code";
        } else {
            btn.textContent = `Resend in ${otpCountdownValue}s`;
        }
    }, 1000);
}

async function handleVerifyOtp() {
    const code = document.getElementById('otpCode').value.trim();

    if (!code || code.length !== 6) {
        toast("❌ Please enter the 6-digit verification code");
        return;
    }

    if (!supabaseClient) {
        toast("⚠️ Supabase service is unavailable. Please check your connection.");
        return;
    }
    toast("⏳ Verifying code...");
    const { data, error } = await supabaseClient.auth.verifyOtp({
        email: otpEmail,
        token: code,
        type: 'email'
    });

    if (error) {
        toast(`❌ Verification failed: ${error.message}`);
    } else {
        toast("✅ Code verified successfully!");
        if (otpTimer) {
            clearInterval(otpTimer);
            otpTimer = null;
        }
    }
}

async function handleResendOtp() {
    if (!otpEmail) return;
    
    if (!supabaseClient) {
        toast("⚠️ Supabase service is unavailable. Please check your connection.");
        return;
    }
    toast("⏳ Resending code...");
    
    const options = {};
    if (otpSourceScreen === 'signup' && otpName) {
        options.data = { full_name: otpName };
    }

    const { error } = await supabaseClient.auth.signInWithOtp({
        email: otpEmail,
        options: options
    });

    if (error) {
        toast(`❌ Resend failed: ${error.message}`);
    } else {
        toast("✅ New code sent!");
        document.getElementById('otpCode').value = '';
        startOtpCountdown();
    }
}

function cancelOtpFlow() {
    if (otpTimer) {
        clearInterval(otpTimer);
        otpTimer = null;
    }
    showAuthTab(otpSourceScreen);
}

async function handleSignOut() {
    if (!supabaseClient) {
        toast("⚠️ Supabase service is unavailable. Please check your connection.");
        return;
    }
    if (confirm("Logout of your account?")) {
        const { error } = await supabaseClient.auth.signOut();
        if (error) {
            toast(`Error: ${error.message}`);
        } else {
            toast("👋 Logged out successfully");
        }
    }
}

async function handleGoogleSignIn() {
    toast("⏳ Connecting to Google...");
    if (!supabaseClient) {
        toast("⚠️ Supabase service is unavailable. Please check your connection.");
        return;
    }
    try {
        const redirectUrl = window.location.origin + window.location.pathname;

        const { error } = await supabaseClient.auth.signInWithOAuth({
            provider: 'google',
            options: {
                redirectTo: redirectUrl
            }
        });
        if (error) throw error;
    } catch (err) {
        toast(`❌ Google Login failed: ${err.message}`);
    }
}

// ===== ACCSOFT PORTAL LOGINS =====
// ===== ACCSOFT PORTAL LOGINS =====
async function checkConnectionAndLoadData(preloadedConn = null) {
    console.log('[PROFILE] Loading profile');
    try {
        let conn = preloadedConn;
        if (!conn) {
            console.log('[CONNECTION] Checking AccSoft connection');
            if (!supabaseClient) {
                throw new Error("Supabase SDK is not initialized.");
            }
            // Fetch connection record
            console.log('[ON_AUTH_STATE_CHANGE] checkConnectionAndLoadData: before await query accsoft_connections');
            const { data, error } = await supabaseClient
                .from('accsoft_connections')
                .select('*')
                .eq('user_id', currentUser.id)
                .maybeSingle();
            console.log('[ON_AUTH_STATE_CHANGE] checkConnectionAndLoadData: after await query accsoft_connections');

            if (error) {
                console.error('[CONNECTION ERROR]', error);
                throw error;
            }
            conn = data;
        }

        console.log('[CONNECTION] Result', conn);
        connectionData = conn;
        console.log('[PROFILE] Loaded', conn);

        if (conn && currentUser) {
            saveCachedData(currentUser.id);
        }

        if (!conn) {
            console.log("[PROFILE] User has no AccSoft connection record. Redirecting to connect screen.");
            showAuthTab('connect');
            isAppReady = true;
            checkAndHideSplash();
        } else {
            console.log("[PROFILE] User has AccSoft connection. Loading dashboard...");
            hideOfflineBanner();
            console.log("[AUTH] Redirecting to dashboard");
            showDashboardView();
            
            // Set header labels
            updateWelcomeHeader(currentUser);
            
            // Refresh local state lists
            pendingInitStep = 'load-attendance-data';
            try {
                console.log('[ON_AUTH_STATE_CHANGE] checkConnectionAndLoadData: before await refreshData');
                await refreshData();
                console.log('[ON_AUTH_STATE_CHANGE] checkConnectionAndLoadData: after await refreshData');
            } catch (refreshErr) {
                console.error("[PROFILE] refreshData failed during connection load:", refreshErr);
            }
        }
        isAppReady = true;
        checkAndHideSplash();
    } catch (err) {
        console.error('[PROFILE ERROR]', err);
        if (currentUser) {
            // Bypass login redirect since session exists
            console.log("[AUTH] Redirecting to dashboard");
            showDashboardView();
            
            isAppReady = true;
            isTimerDone = true;
            checkAndHideSplash();
            
            showOfflineBanner("Offline Mode");
            toast("⚠️ Connection error. Loaded offline mode.");
        } else {
            handleInitializationFailure(err);
        }
    }
}

async function handleConnectAccsoft() {
    const enroll = document.getElementById('accsoftEnroll').value.trim();
    const pass = document.getElementById('accsoftPass').value;

    if (!enroll || !pass) {
        toast("❌ Please enter both fields");
        return;
    }

    const connectLoading = document.getElementById('connectLoading');
    if (connectLoading) connectLoading.style.display = 'flex';

    toast("⏳ Connecting account (Verifying credentials)...");
    
    if (!supabaseClient) {
        toast("⚠️ Supabase service is unavailable. Please check your connection.");
        if (connectLoading) connectLoading.style.display = 'none';
        return;
    }
    // Retrieve user session token
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) {
        toast("Session expired. Please log in again.");
        if (connectLoading) connectLoading.style.display = 'none';
        return;
    }

    try {
        const response = await fetch(`${window.SYNC_SERVICE_URL}/connect-accsoft`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`
            },
            body: JSON.stringify({ enrollment_no: enroll, password: pass })
        });

        const resData = await response.json();
        
        if (!response.ok) {
            throw new Error(resData.error || 'Connection failed');
        }

        toast("✅ Connected successfully!");
        
        // Hide loader
        if (connectLoading) connectLoading.style.display = 'none';
        
        // Construct the connection object directly to bypass replication race condition
        const connObj = {
            user_id: session.user.id,
            enrollment_no: enroll,
            last_sync_at: new Date().toISOString(),
            last_sync_status: 'SUCCESS',
            last_sync_message: 'Successfully connected and verified account.'
        };
        
        // Refresh connection details locally and load dashboard directly
        await checkConnectionAndLoadData(connObj);

        // Auto-trigger sync on first connection
        console.log("[CONNECT] Auto-triggering first sync...");
        triggerSyncNow();

    } catch (err) {
        if (connectLoading) connectLoading.style.display = 'none';
        toast(`❌ ${err.message}`);
    }
}

function openReconnectForm() {
    // Put UI back into connection state
    document.getElementById('ob').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
    showAuthTab('connect');
}

async function handleDisconnectAccsoft() {
    if (!confirm("Are you sure you want to disconnect your AccSoft portal? This will delete all connection details and synced attendance history!")) {
        return;
    }

    if (!supabaseClient) {
        toast("⚠️ Supabase service is unavailable. Please check your connection.");
        return;
    }
    toast("⏳ Disconnecting...");
    try {
        const { error } = await supabaseClient
            .from('accsoft_connections')
            .delete()
            .eq('user_id', currentUser.id);

        if (error) throw error;

        toast("🗑️ Disconnected portal successfully");
        // Clear cached data from localStorage
        if (currentUser) {
            localStorage.removeItem(`ae_conn_${currentUser.id}`);
            localStorage.removeItem(`ae_sum_${currentUser.id}`);
            localStorage.removeItem(`ae_logs_${currentUser.id}`);
        }
        connectionData = null;
        summaryData = [];
        logsData = [];

        await checkConnectionAndLoadData();
    } catch (err) {
        toast(`Error: ${err.message}`);
    }
}

// ===== ATTENDANCE MANUAL SYNC PIPELINE =====
// ===== ATTENDANCE MANUAL SYNC PIPELINE =====
async function triggerSyncNow() {
    console.log('[SEQUENTIAL] A: function entered');
    try {
        if (isSyncInProgress) {
            console.log('[SYNC] Blocked: Sync already in progress.');
            return;
        }
        isSyncInProgress = true;
        console.log('[SYNC] Started');
        
        const syncIcon = document.getElementById('headerSyncIcon');
        if (syncIcon) syncIcon.classList.add('spin-animation');

        const modal = document.getElementById('syncingModal');
        const stepLogin = document.getElementById('syncStepLogin');
        const stepFetch = document.getElementById('syncStepFetch');
        const stepSave = document.getElementById('syncStepSave');
        const bar = document.getElementById('syncProgressBar');
        const text = document.getElementById('syncProgressText');

        // Reset Sync Progress UI
        modal.classList.remove('hidden');
        stepLogin.innerHTML = '<span class="sync-bullet pending"></span> logging to accsoft';
        stepLogin.style.color = 'var(--text-sec)';
        stepFetch.innerHTML = '<span class="sync-bullet pending"></span> fetching attendance';
        stepFetch.style.color = 'var(--text-sec)';
        stepSave.innerHTML = '<span class="sync-bullet pending"></span> fetched saved to database';
        stepSave.style.color = 'var(--text-sec)';
        bar.style.width = '0%';
        text.textContent = '0 / 3';

        let isSyncFinished = false;
        const progressIntervals = [];

        // Timeout guard at 120 seconds (helps wake up cold containers + allows slow scrapers to resolve)
        const syncTimeout = setTimeout(() => {
            if (!isSyncFinished) {
                console.error('[SYNC] Timeout');
                const sIcon = document.getElementById('headerSyncIcon');
                if (sIcon) sIcon.classList.remove('spin-animation');
                modal.classList.add('hidden');
                toast("Sync timed out. Please try again.");
                isSyncFinished = true;
                isSyncInProgress = false; // Reset lock
                progressIntervals.forEach(clearTimeout);
            }
        }, 120000);

        if (!supabaseClient) {
            clearTimeout(syncTimeout);
            const sIcon = document.getElementById('headerSyncIcon');
            if (sIcon) sIcon.classList.remove('spin-animation');
            isSyncFinished = true;
            isSyncInProgress = false; // Reset lock
            modal.classList.add('hidden');
            toast("⚠️ Supabase service is unavailable. Please check your connection.");
            return;
        }

        let session = null;
        const getSessionStartTime = Date.now();
        console.log('[SEQUENTIAL] B: before getSession');
        console.log('[DIAGNOSTIC] getSession started');
        let getSessionTimedOutOrFailed = false;

        try {
            const res = await promiseWithTimeout(
                supabaseClient.auth.getSession(),
                5000,
                'getSession timeout'
            );
            const duration = Date.now() - getSessionStartTime;
            console.log(`[DIAGNOSTIC] getSession finished (${duration}ms)`);
            console.log('[SEQUENTIAL] C: after getSession');
            session = res.data?.session;
        } catch (err) {
            getSessionTimedOutOrFailed = true;
            const duration = Date.now() - getSessionStartTime;
            console.warn(`[DIAGNOSTIC] getSession timed out or failed after ${duration}ms:`, err);
            console.log('[SEQUENTIAL] C: after getSession (failed/timed out)');
        }

        if (isSyncFinished) return;

        if (getSessionTimedOutOrFailed) {
            const refreshSessionStartTime = Date.now();
            console.log('[SEQUENTIAL] D: before refreshSession');
            console.log('[DIAGNOSTIC] refreshSession started');
            try {
                const res = await promiseWithTimeout(
                    safeRefreshSession(),
                    8000,
                    'refreshSession timeout'
                );
                const duration = Date.now() - refreshSessionStartTime;
                console.log(`[DIAGNOSTIC] refreshSession finished (${duration}ms)`);
                console.log('[SEQUENTIAL] E: after refreshSession');
                session = res.data?.session;
            } catch (err) {
                const duration = Date.now() - refreshSessionStartTime;
                console.error(`[DIAGNOSTIC] refreshSession finished with error/timeout after ${duration}ms:`, err);
                console.log('[SEQUENTIAL] E: after refreshSession (failed/timed out)');
            }
        } else {
            console.log('[SEQUENTIAL] D: refreshSession skipped (getSession succeeded)');
            console.log('[SEQUENTIAL] E: refreshSession skipped (getSession succeeded)');
        }

        if (isSyncFinished) return;

        if (!session) {
            clearTimeout(syncTimeout);
            isSyncFinished = true;
            isSyncInProgress = false; // Reset lock
            progressIntervals.forEach(clearTimeout);
            modal.classList.add('hidden');
            toast("Session expired. Please log in again.");
            return;
        }


        // Helper to register timed progress updates
        const addProgressStep = (delay, callback) => {
            const timer = setTimeout(() => {
                if (!isSyncFinished) {
                    callback();
                }
            }, delay);
            progressIntervals.push(timer);
        };

        // Step 1: Logging in (0.4s)
        addProgressStep(400, () => {
            stepLogin.innerHTML = '<span class="sync-bullet active"></span> logging to accsoft...';
            stepLogin.style.color = 'var(--primary)';
            bar.style.width = '15%';
            text.textContent = '0.5 / 3';
        });

        // Step 2: Cold start wake up (10s)
        addProgressStep(10000, () => {
            stepLogin.innerHTML = '<span class="sync-bullet active"></span> logging to accsoft...';
            stepLogin.style.color = 'var(--primary)';
            bar.style.width = '30%';
            text.textContent = '1.0 / 3';
        });

        // Step 3: Fetching attendance data (20s)
        addProgressStep(20000, () => {
            stepLogin.innerHTML = '<span class="sync-bullet done"></span> logging to accsoft';
            stepLogin.style.color = 'var(--green)';
            stepFetch.innerHTML = '<span class="sync-bullet active"></span> fetching attendance...';
            stepFetch.style.color = 'var(--primary)';
            bar.style.width = '50%';
            text.textContent = '1.5 / 3';
        });

        // Step 4: Scraping taking longer (35s)
        addProgressStep(35000, () => {
            stepFetch.innerHTML = '<span class="sync-bullet active"></span> fetching attendance...';
            stepFetch.style.color = 'var(--primary)';
            bar.style.width = '70%';
            text.textContent = '2.0 / 3';
        });

        // Step 5: Saving to database (55s)
        addProgressStep(55000, () => {
            stepFetch.innerHTML = '<span class="sync-bullet done"></span> fetching attendance';
            stepFetch.style.color = 'var(--green)';
            stepSave.innerHTML = '<span class="sync-bullet active"></span> fetched saved to database...';
            stepSave.style.color = 'var(--primary)';
            bar.style.width = '85%';
            text.textContent = '2.5 / 3';
        });

        // Generate unique correlation ID
        const correlationId = 'sync_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
        console.log('[SEQUENTIAL] F: before fetch');
        console.log(`[DIAGNOSTIC] fetch started with Correlation ID: ${correlationId}`);

        try {
            // Trigger manual sync API
            const response = await fetch(`${window.SYNC_SERVICE_URL}/sync-attendance`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${session.access_token}`,
                    'X-Correlation-ID': correlationId
                }
            });

            if (isSyncFinished) return;

            console.log('[DIAGNOSTIC] fetch completed');
            console.log('[SEQUENTIAL] G: after fetch');
            const resData = await response.json();
            
            if (isSyncFinished) return;

            if (!response.ok) {
                throw new Error(resData.error || 'Synchronization failed');
            }

            if (isSyncFinished) return;
            clearTimeout(syncTimeout);
            progressIntervals.forEach(clearTimeout);
            isSyncFinished = true;

            // Fast forward animations to success state
            stepLogin.innerHTML = '<span class="sync-bullet done"></span> logging to accsoft';
            stepLogin.style.color = 'var(--green)';
            bar.style.width = '33%';
            
            stepFetch.innerHTML = '<span class="sync-bullet done"></span> fetching attendance';
            stepFetch.style.color = 'var(--green)';
            bar.style.width = '66%';
            
            stepSave.innerHTML = '<span class="sync-bullet done"></span> fetched saved to database';
            stepSave.style.color = 'var(--green)';
            bar.style.width = '100%';
            text.textContent = '3 / 3';

            setTimeout(() => {
                const sIcon = document.getElementById('headerSyncIcon');
                if (sIcon) sIcon.classList.remove('spin-animation');
                modal.classList.add('hidden');
                toast("✅ Sync completed successfully!");
                refreshData();
                isSyncInProgress = false; // Reset lock
            }, 1000);
            console.log('[SYNC] Finished');
            console.log('[SEQUENTIAL] H: function completed');

        } catch (err) {
            console.error('[DIAGNOSTIC] fetch failed', err);
            console.log('[SEQUENTIAL] G: after fetch (failed)');
            const sIcon = document.getElementById('headerSyncIcon');
            if (sIcon) sIcon.classList.remove('spin-animation');
            if (isSyncFinished) return;
            clearTimeout(syncTimeout);
            progressIntervals.forEach(clearTimeout);
            isSyncFinished = true;
            isSyncInProgress = false; // Reset lock

            modal.classList.add('hidden');
            toast(`❌ ${err.message}`);
            await refreshData(); // Refresh to update error message on connection state card
            
            throw err;
        }

    } catch (topErr) {
        console.error('[TOP-LEVEL EXCEPTION IN triggerSyncNow]', topErr);
        const sIcon = document.getElementById('headerSyncIcon');
        if (sIcon) sIcon.classList.remove('spin-animation');
        isSyncInProgress = false;
        throw topErr;
    }
}

// ===== DATABASE REFRESH & STATE MANAGEMENT =====
// ===== DATABASE REFRESH & STATE MANAGEMENT =====
async function refreshData() {
    try {
        console.log("[DASHBOARD] Refreshing local cached attendance data from database...");
        if (!supabaseClient) {
            throw new Error("Supabase SDK is not initialized.");
        }
        
        // Fetch connection record again
        console.log('[CONNECTION] Checking AccSoft connection');
        try {
            console.log('[ON_AUTH_STATE_CHANGE] refreshData: before await conn single');
            const { data: conn, error: connErr } = await supabaseClient
                .from('accsoft_connections')
                .select('*')
                .eq('user_id', currentUser.id)
                .single();
            console.log('[ON_AUTH_STATE_CHANGE] refreshData: after await conn single');

            if (connErr) {
                console.error('[CONNECTION ERROR]', connErr);
                throw connErr;
            }
            console.log('[CONNECTION] Result', conn);
            connectionData = conn;
        } catch (dbErr) {
            console.warn("[DASHBOARD] Could not query latest connection details from DB, using fallback memory connectionData:", dbErr);
            if (!connectionData) {
                throw dbErr;
            }
        }

        // Update welcome card subtext (Last Sync time)
        const lastSyncEl = document.getElementById('headerLastSync');
        if (lastSyncEl) {
            if (connectionData) {
                lastSyncEl.textContent = connectionData.last_sync_at ? `Last sync: ${timeAgo(connectionData.last_sync_at)}` : 'Never';
            } else {
                lastSyncEl.textContent = 'Not Connected';
            }
        }

        // Fetch Summary
        console.log('[SUMMARY] Loading attendance summary');
        console.log('[ON_AUTH_STATE_CHANGE] refreshData: before await attendance_summary select');
        const { data: summaries, error: sumErr } = await supabaseClient
            .from('attendance_summary')
            .select('*')
            .eq('user_id', currentUser.id)
            .order('subject_name');
        console.log('[ON_AUTH_STATE_CHANGE] refreshData: after await attendance_summary select');

        if (sumErr) {
            console.error('[SUMMARY ERROR]', sumErr);
            throw sumErr;
        }
        console.log('[SUMMARY] Count', summaries?.length);
        summaryData = summaries || [];

        // Fetch logs
        console.log('[LOGS] Loading attendance logs');
        console.log('[ON_AUTH_STATE_CHANGE] refreshData: before await attendance_logs select');
        const { data: logs, error: logsErr } = await supabaseClient
            .from('attendance_logs')
            .select('*')
            .eq('user_id', currentUser.id)
            .order('attendance_date', { ascending: false })
            .order('period_no', { ascending: true });
        console.log('[ON_AUTH_STATE_CHANGE] refreshData: after await attendance_logs select');

        if (logsErr) {
            console.error('[LOGS ERROR]', logsErr);
            throw logsErr;
        }
        console.log('[LOGS] Count', logs?.length);
        logsData = logs || [];

        // Render UI panels
        pendingInitStep = 'render-dashboard';
        console.log("[DASHBOARD] Rendering UI panels...");
        updateSyncStatusStrip();
        renderDashboard();
        renderSubjects();
        populateHistoryFilters();
        renderHistory();
        renderInsights();
        renderSettingsPage();
        hideOfflineBanner();
        console.log("[DASHBOARD] All UI elements successfully rendered.");

        // Save successfully loaded data to cache
        saveCachedData(currentUser.id);

    } catch (err) {
        console.error("[DASHBOARD] Data refresh failed:", err);
        console.error('[CONNECTION ERROR]', err);
        console.error('[SUMMARY ERROR]', err);
        console.error('[LOGS ERROR]', err);
        showOfflineBanner("Offline Mode");
        toast("⚠️ Failed to load attendance data. Offline mode.");
        
        // Render dashboard with empty/offline states instead of throwing
        try {
            renderDashboard();
            renderSubjects();
            populateHistoryFilters();
            renderHistory();
            renderInsights();
            renderSettingsPage();
        } catch (renderErr) {
            console.error("[DASHBOARD] Rendering failed during offline fallback:", renderErr);
        }
    }
}

function updateSyncStatusStrip() {
    const dot = document.getElementById('syncStatusDot');
    const lbl = document.getElementById('syncStatusLbl');

    if (!connectionData) return;

    const lastSyncStr = connectionData.last_sync_at ? fmtDateTime(connectionData.last_sync_at) : 'Never';

    if (lbl) {
        if (connectionData.last_sync_status === 'SUCCESS') {
            lbl.textContent = `Synced: ${lastSyncStr}`;
            if (dot) dot.style.background = 'var(--green)';
        } else if (connectionData.last_sync_status) {
            lbl.textContent = `Sync Failed: ${connectionData.last_sync_status}`;
            if (dot) dot.style.background = 'var(--red)';
        } else {
            lbl.textContent = 'Never Synced';
            if (dot) dot.style.background = 'var(--orange)';
        }
    }
}

// ===== UI PANEL RENDERING =====
function renderDashboard() {
    const fallback = document.getElementById('dashboardFallback');
    const fallbackTitle = document.getElementById('dashboardFallbackTitle');
    const fallbackSub = document.getElementById('dashboardFallbackSub');
    const fallbackBtn = document.getElementById('dashboardFallbackBtn');
    
    const statsContainer = document.getElementById('dashboardStats');
    const dailyLogsList = document.getElementById('dashDailyLogsList');
    
    // Check fallback state first
    if (!connectionData) {
        fallback.style.display = 'block';
        statsContainer.style.display = 'none';
        fallbackTitle.textContent = 'Connect AccSoft to get started';
        fallbackSub.textContent = 'Sync your attendance to view statistics, analytics, and subject-wise logs.';
        fallbackBtn.textContent = 'Connect Account';
        fallbackBtn.onclick = () => showWelcomeScreen();
        return;
    }

    if (!connectionData.last_sync_at) {
        fallback.style.display = 'block';
        statsContainer.style.display = 'none';
        fallbackTitle.textContent = 'Sync attendance to view your data';
        fallbackSub.textContent = 'We need to pull your records from the AccSoft portal for the first time.';
        fallbackBtn.textContent = 'Sync Now';
        fallbackBtn.onclick = () => triggerSyncNow();
        return;
    }

    if (summaryData.length === 0) {
        fallback.style.display = 'block';
        statsContainer.style.display = 'none';
        fallbackTitle.textContent = 'No attendance data found';
        fallbackSub.textContent = 'Synchronization completed, but no subject records were retrieved.';
        fallbackBtn.textContent = 'Sync Now';
        fallbackBtn.onclick = () => triggerSyncNow();
        return;
    }

    // Display live stats container
    fallback.style.display = 'none';
    statsContainer.style.display = 'block';

    // Calculate aggregated overall statistics
    let totalHeld = 0;
    let totalPresent = 0;
    let totalAbsent = 0;

    summaryData.forEach(s => {
        totalHeld += s.held;
        totalPresent += s.present;
        totalAbsent += s.absent;
    });

    const overallPerc = totalHeld > 0 ? (totalPresent / totalHeld * 100) : 0;
    const ringOffset = 263.89 - (263.89 * Math.min(overallPerc, 100) / 100);

    // Overall Ring Card Updates
    document.getElementById('dashOverallPerc').textContent = `${overallPerc.toFixed(1)}%`;
    const ring = document.getElementById('dashOverallSvgRing');
    if (ring) {
        ring.setAttribute('stroke-dashoffset', ringOffset);
        const ringCol = overallPerc >= 75 ? 'var(--green)' : overallPerc >= 65 ? 'var(--orange)' : 'var(--red)';
        ring.setAttribute('stroke', ringCol);
    }
    
    const label = document.getElementById('dashOverallSvgLabel');
    if (label) {
        label.textContent = `${Math.round(overallPerc)}%`;
    }

    // Set feedback label
    const feedbackLbl = document.getElementById('dashOverallStatus');
    const helpText = document.getElementById('dashOverallHelpText');
    if (feedbackLbl) {
        if (overallPerc >= 75) {
            feedbackLbl.textContent = "Safe Zone";
            feedbackLbl.className = "hero-badge safe";
            if (helpText) helpText.textContent = "Great job! Keep it up.";
        } else if (overallPerc >= 65) {
            feedbackLbl.textContent = "Warning Zone";
            feedbackLbl.className = "hero-badge warning";
            if (helpText) helpText.textContent = "Need 75% to stay safe";
        } else {
            feedbackLbl.textContent = "Critical Zone";
            feedbackLbl.className = "hero-badge critical";
            if (helpText) helpText.textContent = "Bunks not allowed! Missed too many.";
        }
    }

    // Update Recommendation Card directly (Stitch Style)
    const recTitleEl = document.getElementById('dashRecTitle');
    const recSubEl = document.getElementById('dashRecSub');
    const recCardEl = document.getElementById('dashboardRecommendationCard');
    if (recTitleEl && recSubEl) {
        if (overallPerc >= 75) {
            recTitleEl.textContent = "Maintain Safe Zone";
            recSubEl.textContent = "Great job! Keep attending your classes to stay above 75%.";
            if (recCardEl) {
                recCardEl.style.background = 'linear-gradient(135deg, #10B981 0%, #059669 100%)';
                recCardEl.style.boxShadow = '0 10px 24px rgba(16, 185, 129, 0.2)';
            }
        } else {
            const mustAttendOverall = Math.ceil((0.75 * totalHeld - totalPresent) / 0.25);
            if (mustAttendOverall > 0) {
                recTitleEl.textContent = `Attend Next ${mustAttendOverall} Lectures`;
                recSubEl.textContent = `To bring your overall score back to the 75% safe zone.`;
            } else {
                recTitleEl.textContent = "Attend Next 1 Lecture";
                recSubEl.textContent = "To stay in the safe zone.";
            }
            if (recCardEl) {
                recCardEl.style.background = 'linear-gradient(135deg, #7B61FF 0%, #5B4CF0 100%)';
                recCardEl.style.boxShadow = '0 10px 24px rgba(91, 76, 240, 0.2)';
            }
        }
    }

    // Held stats fields
    document.getElementById('dashClassesHeld').textContent = totalHeld;
    document.getElementById('dashClassesPresent').textContent = totalPresent;
    document.getElementById('dashClassesAbsent').textContent = totalAbsent;

    // Render Dynamic Insights Preview (top 2 insights)
    const insightsPreview = document.getElementById('dashInsightsPreviewList');
    if (insightsPreview) {
        insightsPreview.innerHTML = '';
        const insightsList = [];

        if (overallPerc >= 75) {
            insightsList.push({
                type: 'good',
                tag: 'Bunk Prediction',
                title: 'You are in Safe Zone',
                sub: 'Great! Keep it up.',
                icon: '🎯'
            });
        } else {
            const mustAttendOverall = Math.ceil((0.75 * totalHeld - totalPresent) / 0.25);
            if (mustAttendOverall > 0) {
                insightsList.push({
                    type: 'critical',
                    tag: 'Attendance Goal',
                    title: `Must attend ${mustAttendOverall} classes`,
                    sub: 'To reach 75% overall attendance',
                    icon: '⚠️'
                });
            }
        }

        // Lowest subject check
        let lowestSub = null;
        let lowestPerc = 101;
        summaryData.forEach(s => {
            if (s.held > 0 && s.percentage < lowestPerc) {
                lowestPerc = s.percentage;
                lowestSub = s;
            }
        });

        if (lowestSub) {
            insightsList.push({
                type: lowestPerc >= 75 ? 'good' : lowestPerc >= 65 ? 'warning' : 'critical',
                tag: 'Recommendation',
                title: `${lowestSub.subject_name}`,
                sub: `Has your lowest attendance (${lowestPerc.toFixed(1)}%). Try to improve!`,
                icon: '📈'
            });
        }

        insightsList.slice(0, 2).forEach(ins => {
            const card = document.createElement('div');
            card.className = `insight-card`;
            card.style.borderColor = ins.type === 'good' ? 'rgba(46, 204, 113, 0.2)' : ins.type === 'warning' ? 'rgba(230, 126, 34, 0.2)' : 'rgba(231, 76, 60, 0.2)';
            card.style.background = ins.type === 'good' ? 'var(--green-dim)' : ins.type === 'warning' ? 'var(--orange-dim)' : 'var(--red-dim)';
            card.onclick = () => go('insights', document.querySelectorAll('.ntab')[3]);
            card.innerHTML = `
                <div class="insight-left">
                    <span class="insight-tag" style="color: var(--${ins.type === 'good' ? 'green' : ins.type === 'warning' ? 'orange' : 'red'});">${ins.tag}</span>
                    <span class="insight-title" style="color: var(--${ins.type === 'good' ? 'green' : ins.type === 'warning' ? 'orange' : 'red'});">${ins.title}</span>
                    <span class="insight-sub">${ins.sub}</span>
                </div>
                <div class="insight-right">${ins.icon}</div>
            `;
            insightsPreview.appendChild(card);
        });
    }

    // Render Daily logs grouped by date (most recent 3 days)
    if (dailyLogsList) {
        dailyLogsList.innerHTML = '';
        
        // Group logs by date
        const groupedLogs = {};
        logsData.forEach(l => {
            const dateStr = l.attendance_date;
            if (!groupedLogs[dateStr]) {
                groupedLogs[dateStr] = { present: 0, absent: 0, classes: [] };
            }
            const isPresent = l.status === 'P' || l.status.toUpperCase() === 'PRESENT';
            if (isPresent) {
                groupedLogs[dateStr].present++;
            } else {
                groupedLogs[dateStr].absent++;
            }
            groupedLogs[dateStr].classes.push(l);
        });

        // Get sorted dates (most recent first)
        const sortedDates = Object.keys(groupedLogs).sort().reverse();
        const topDates = sortedDates; // Show all days

        if (topDates.length === 0) {
            const emptyEl = document.createElement('div');
            emptyEl.style.textAlign = 'center';
            emptyEl.style.padding = '24px 16px';
            emptyEl.style.color = 'var(--text-sec)';
            emptyEl.style.fontSize = '0.8rem';
            emptyEl.textContent = 'No attendance logs recorded yet.';
            dailyLogsList.appendChild(emptyEl);
        } else {
            topDates.forEach(date => {
                const dayData = groupedLogs[date];
                
                // Format date label to: OCT 24, THURSDAY
                const dObj = new Date(date + 'T12:00:00');
                const month = dObj.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
                const day = dObj.getDate();
                const weekday = dObj.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();
                const formattedDate = `${month} ${day}, ${weekday}`;

                const card = document.createElement('div');
                card.className = 'day-card';
                
                // Header with date (no emoji/badges)
                let headerHtml = `
                    <div class="day-header" style="background: rgba(119, 117, 135, 0.06); padding: 12px 18px; border-bottom: 1px solid rgba(119, 117, 135, 0.08);">
                        <span class="day-date-title" style="font-size: 0.72rem; font-weight: 800; color: var(--text-sec); text-transform: uppercase; letter-spacing: 0.8px;">${formattedDate}</span>
                    </div>
                `;

                // Helper to convert string to Title Case
                const toTitleCase = str => {
                    if (!str) return '';
                    return str.toLowerCase().split(' ').map(word => {
                        return word.charAt(0).toUpperCase() + word.slice(1);
                    }).join(' ');
                };

                // Classes list for that day
                let classesHtml = '<div class="day-classes-list">';
                dayData.classes.forEach(c => {
                    const statusLower = c.status ? c.status.toLowerCase() : '';
                    const isPresent = statusLower === 'p' || statusLower === 'present';
                    const isAbsent = statusLower === 'a' || statusLower === 'absent';
                    const statusText = isPresent ? 'Present' : (isAbsent ? 'Absent' : 'Pending');
                    const statusClass = isPresent ? 'present' : (isAbsent ? 'absent' : 'pending');

                    classesHtml += `
                        <div class="day-class-item" onclick="showSubjectDetail('${c.subject_name}')" style="cursor: pointer; display: flex; justify-content: space-between; align-items: center; padding: 14px 18px; border-bottom: 1px solid rgba(119, 117, 135, 0.06);">
                            <div class="day-class-info" style="margin: 0; padding: 0; flex: 1;">
                                <span class="day-class-subject" style="font-size: 0.92rem; font-weight: 700; color: var(--text);">${toTitleCase(c.subject_name)}</span>
                            </div>
                            <span class="day-class-status ${statusClass}" style="margin-left: 12px;">${statusText}</span>
                        </div>
                    `;
                });
                classesHtml += '</div>';

                card.innerHTML = headerHtml + classesHtml;
                dailyLogsList.appendChild(card);
            });
        }
    }
    console.log('[DASHBOARD] Dashboard rendered');
}

function renderSubjects() {
    const container = document.getElementById('subjC');
    const fallback = document.getElementById('subjectsListFallback');

    container.innerHTML = '';

    if (summaryData.length === 0) {
        fallback.style.display = 'block';
        return;
    }

    fallback.style.display = 'none';

    summaryData.forEach(s => {
        const percCol = s.percentage >= 75 ? 'var(--green)' : s.percentage >= 65 ? 'var(--orange)' : 'var(--red)';
        
        // Generate a dynamic code (e.g. "Basic Computer Engineering" -> "BCE")
        const words = s.subject_name.split(/[\s-]+/);
        let code = words.map(w => w[0]).join('').toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (code.length === 0) code = 'SUB';
        if (code.length > 5) code = code.slice(0, 5);

        // Circular progress ring calculations (radius = 26, circumference = 163.36)
        const radius = 26;
        const circumference = 2 * Math.PI * radius; // ~163.36
        const offset = circumference - (circumference * Math.min(s.percentage, 100) / 100);

        const card = document.createElement('div');
        card.className = 'glass-card subj-card';
        card.onclick = () => showSubjectDetail(s.subject_name);
        card.innerHTML = `
            <div class="subj-card-header">
                <div class="subj-card-info">
                    <span class="subj-card-code">${code}</span>
                    <h3 class="subj-card-title">${s.subject_name}</h3>
                </div>
                <div class="subj-card-ring-box">
                    <svg viewBox="0 0 64 64" style="width: 52px; height: 52px; transform: rotate(-90deg);">
                        <circle cx="32" cy="32" r="26" style="fill: none; stroke: var(--border); stroke-width: 4.5px;" />
                        <circle cx="32" cy="32" r="26" style="fill: none; stroke-width: 4.5px; stroke-linecap: round; transition: stroke-dashoffset 0.8s ease-in-out;" stroke-dasharray="${circumference}" stroke-dashoffset="${offset}" stroke="${percCol}" />
                    </svg>
                    <span class="subj-card-perc-text" style="color: ${percCol}">${Math.round(s.percentage)}%</span>
                </div>
            </div>
            <div class="subj-card-stats-grid">
                <div class="subj-stat-box">
                    <span class="subj-stat-label">HELD</span>
                    <span class="subj-stat-value">${s.held}</span>
                </div>
                <div class="subj-stat-box" style="border-bottom: 2px solid ${percCol};">
                    <span class="subj-stat-label">ATTENDED</span>
                    <span class="subj-stat-value" style="color: ${percCol}">${s.present}</span>
                </div>
                <div class="subj-stat-box">
                    <span class="subj-stat-label">MISSED</span>
                    <span class="subj-stat-value">${s.absent}</span>
                </div>
            </div>
        `;
        container.appendChild(card);
    });
}

function populateHistoryFilters() {
    const subSel = document.getElementById('historyFilterSub');
    if (!subSel) return;

    const currentSelVal = subSel.value;
    subSel.innerHTML = '<option value="all">All Subjects</option>';
    
    // Unique subject list
    const subjects = [...new Set(logsData.map(l => l.subject_name))].sort();
    subjects.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s;
        opt.textContent = s;
        subSel.appendChild(opt);
    });

    if (currentSelVal) {
        subSel.value = currentSelVal;
    }
}

function applyHistoryFilters() {
    renderHistory();
}

function renderHistory() {
    const container = document.getElementById('historyLogsContainer');
    const fallback = document.getElementById('historyFallback');
    if (!container || !fallback) return;
    
    container.innerHTML = '';

    if (logsData.length === 0) {
        fallback.style.display = 'block';
        return;
    }

    fallback.style.display = 'none';

    // Apply Filter Selections
    const filterSub = document.getElementById('historyFilterSub').value;
    const filterStatus = document.getElementById('historyFilterStatus').value;

    const filtered = logsData.filter(l => {
        const matchesSub = filterSub === 'all' || l.subject_name === filterSub;
        const matchesStatus = filterStatus === 'all' || l.status === filterStatus;
        return matchesSub && matchesStatus;
    });

    if (filtered.length === 0) {
        container.innerHTML = '<div style="text-align:center; padding: 24px; color: var(--text-sec); font-size:0.8rem;">No records matching filters</div>';
        return;
    }

    // Group logs by date
    const grouped = {};
    filtered.forEach(l => {
        if (!grouped[l.attendance_date]) {
            grouped[l.attendance_date] = [];
        }
        grouped[l.attendance_date].push(l);
    });

    // Render grouped lists
    Object.keys(grouped).sort().reverse().forEach(date => {
        const groupDiv = document.createElement('div');
        groupDiv.className = 'hist-group';
        
        // Date Label Header
        const dateLbl = document.createElement('div');
        dateLbl.className = 'hist-date-lbl';
        
        // Calculate formatted label
        const dow = DNAMES[new Date(date + 'T12:00:00').getDay()];
        dateLbl.textContent = `${fmtD(date)} • ${dow}`;
        groupDiv.appendChild(dateLbl);

        // Append rows
        grouped[date].forEach(l => {
            const row = document.createElement('div');
            row.className = 'hist-row';
            row.innerHTML = `
                <div class="hist-info">
                    <div class="hist-sub">${l.subject_name}</div>
                    <div class="hist-period">Period ${l.period_no || '--'}</div>
                </div>
                <div class="hist-status ${l.status.toLowerCase()}">${l.status}</div>
            `;
            groupDiv.appendChild(row);
        });

        container.appendChild(groupDiv);
    });
}

function renderInsights() {
    const fallback = document.getElementById('insightsFallback');
    const container = document.getElementById('insightsContainer');
    if (!container) return;

    container.innerHTML = '';

    if (summaryData.length === 0) {
        if (fallback) fallback.style.display = 'block';
        container.style.display = 'none';
        return;
    }

    if (fallback) fallback.style.display = 'none';
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.gap = '12px';

    summaryData.forEach(s => {
        if (s.held === 0) return;

        if (s.percentage >= 75) {
            // Calculate safe bunks
            const safeBunk = Math.floor((s.present - 0.75 * s.held) / 0.75);
            if (safeBunk > 0) {
                const card = document.createElement('div');
                card.className = 'insight-card glass-card';
                card.style.borderColor = 'rgba(46, 204, 113, 0.2)';
                card.style.background = 'var(--green-dim)';
                card.style.display = 'flex';
                card.style.flexDirection = 'column';
                card.style.gap = '12px';
                card.onclick = () => showSubjectDetail(s.subject_name);
                card.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: flex-start; width: 100%;">
                        <div class="insight-left">
                            <span class="insight-tag" style="color: var(--green);">Bunk Prediction</span>
                            <span class="insight-title" style="color: var(--green); font-size: 1.4rem; font-weight: 800;">${safeBunk} classes</span>
                            <span class="insight-sub" style="margin-top: 4px;">Safe to skip in <span style="text-transform: uppercase;">${s.subject_name}</span></span>
                        </div>
                        <div style="background: rgba(46, 204, 113, 0.12); width: 42px; height: 42px; border-radius: 12px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; color: var(--green);">
                            <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm0-12c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm0 6c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/>
                            </svg>
                        </div>
                    </div>
                    <div style="height: 6px; width: 100%; background: rgba(119, 117, 135, 0.12); border-radius: 999px; overflow: hidden;">
                        <div style="height: 100%; width: ${Math.min(100, s.percentage)}%; background: var(--green); border-radius: 999px;"></div>
                    </div>
                `;
                container.appendChild(card);
            }
        } else {
            // Calculate must attend
            const mustAttend = Math.ceil((0.75 * s.held - s.present) / 0.25);
            if (mustAttend > 0) {
                const card = document.createElement('div');
                card.className = 'insight-card glass-card';
                card.style.borderColor = 'rgba(231, 76, 60, 0.2)';
                card.style.background = 'var(--red-dim)';
                card.style.display = 'flex';
                card.style.flexDirection = 'column';
                card.style.gap = '12px';
                card.onclick = () => showSubjectDetail(s.subject_name);
                card.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: flex-start; width: 100%;">
                        <div class="insight-left">
                            <span class="insight-tag" style="color: var(--red);">Attendance Goal</span>
                            <span class="insight-title" style="color: var(--red); font-size: 1.4rem; font-weight: 800;">${mustAttend} consecutive</span>
                            <span class="insight-sub" style="margin-top: 4px;">Must attend classes in <span style="text-transform: uppercase;">${s.subject_name}</span></span>
                        </div>
                        <div style="background: rgba(231, 76, 60, 0.12); width: 42px; height: 42px; border-radius: 12px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; color: var(--red);">
                            <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
                            </svg>
                        </div>
                    </div>
                    <div style="height: 6px; width: 100%; background: rgba(119, 117, 135, 0.12); border-radius: 999px; overflow: hidden;">
                        <div style="height: 100%; width: ${Math.min(100, s.percentage)}%; background: var(--red); border-radius: 999px;"></div>
                    </div>
                `;
                container.appendChild(card);
            }
        }
    });

    // Render lowest attendance card
    let lowestSub = null;
    let lowestPerc = 101;
    summaryData.forEach(s => {
        if (s.held > 0 && s.percentage < lowestPerc) {
            lowestPerc = s.percentage;
            lowestSub = s;
        }
    });

    if (lowestSub) {
        const card = document.createElement('div');
        card.className = 'insight-card glass-card';
        card.style.borderColor = 'rgba(230, 126, 34, 0.2)';
        card.style.background = 'var(--orange-dim)';
        card.style.display = 'flex';
        card.style.flexDirection = 'column';
        card.style.gap = '12px';
        card.onclick = () => showSubjectDetail(lowestSub.subject_name);
        card.innerHTML = `
            <div style="display: flex; justify-content: space-between; align-items: flex-start; width: 100%;">
                <div class="insight-left">
                    <span class="insight-tag" style="color: var(--orange);">Lowest Attendance</span>
                    <span class="insight-title" style="color: var(--orange); font-size: 1.25rem; font-weight: 800; text-transform: uppercase;">${lowestSub.subject_name}</span>
                    <span class="insight-sub" style="margin-top: 4px;">Has your lowest attendance (${lowestPerc.toFixed(1)}%). Try to improve!</span>
                </div>
                <div style="background: rgba(230, 126, 34, 0.12); width: 42px; height: 42px; border-radius: 12px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; color: var(--orange);">
                    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/>
                        <polyline points="17 6 23 6 23 12"/>
                    </svg>
                </div>
            </div>
            <div style="height: 6px; width: 100%; background: rgba(119, 117, 135, 0.12); border-radius: 999px; overflow: hidden;">
                <div style="height: 100%; width: ${Math.min(100, lowestPerc)}%; background: var(--orange); border-radius: 999px;"></div>
            </div>
        `;
        container.appendChild(card);
    }
}

function renderSettingsPage() {
    const enrollLbl = document.getElementById('settingsEnrollLbl');
    const badge = document.getElementById('settingsConnectionBadge');
    const syncLbl = document.getElementById('settingsLastSyncLbl');
    const nameLbl = document.getElementById('settingsProfileName');
    const emailLbl = document.getElementById('settingsProfileEmail');

    if (!connectionData) {
        if (enrollLbl) enrollLbl.textContent = 'Accsoft User ID: Not Connected';
        if (badge) {
            badge.textContent = 'Disconnected';
            badge.className = 'hero-badge critical';
        }
        if (syncLbl) syncLbl.textContent = 'Last Synced: Never';
    } else {
        if (enrollLbl) enrollLbl.textContent = `Accsoft User ID: ${connectionData.enrollment_no}`;
        if (badge) {
            badge.textContent = connectionData.last_sync_status === 'SUCCESS' ? 'Connected' : 'Sync Error';
            badge.className = connectionData.last_sync_status === 'SUCCESS' ? 'hero-badge safe' : 'hero-badge critical';
        }
        if (syncLbl) {
            const lastStr = connectionData.last_sync_at ? fmtDateTime(connectionData.last_sync_at) : 'Never';
            syncLbl.textContent = `Last Synced: ${lastStr}`;
        }
    }

    if (currentUser) {
        if (nameLbl) nameLbl.textContent = currentUser.user_metadata?.full_name || 'Student';
        if (emailLbl) emailLbl.textContent = currentUser.email || '';
    }
}

// ===== THEME & NAV TOGGLES =====
function toggleTheme() {
    const on = document.body.classList.toggle('lm');
    localStorage.setItem('ae_theme', on ? 'lm' : 'dk');
    const checkbox = document.getElementById('themeBtn');
    if (checkbox) checkbox.checked = on;
}

function initializeHistoryState() {
    if (currentUser && !history.state) {
        history.replaceState({ view: 'overview', subjectName: null }, '');
    }
}

window.addEventListener('popstate', (event) => {
    const appEl = document.getElementById('app');
    if (!appEl || appEl.style.display === 'none') {
        return;
    }

    const state = event.state;
    if (state && state.view) {
        if (state.view === 'subject-detail') {
            showSubjectDetail(state.subjectName, false);
        } else {
            go(state.view, null, false);
        }
    } else {
        if (currentUser) {
            history.replaceState({ view: 'overview', subjectName: null }, '');
            go('overview', null, false);
        }
    }
});

function showDashboardView() {
    const obEl = document.getElementById('ob');
    const appEl = document.getElementById('app');
    if (obEl) obEl.style.display = 'none';
    if (appEl) appEl.style.display = 'flex';
    initializeHistoryState();
}

function go(v, el, pushToHistory = true) {
    const currentActiveView = document.querySelector('.view.act');
    const isNewView = !currentActiveView || currentActiveView.id !== 'v-' + v;

    document.querySelectorAll('.view').forEach(x => x.classList.remove('act'));
    document.querySelectorAll('.ntab').forEach(x => x.classList.remove('act'));
    
    // Hide subject detail explicitly if going to another tab
    const detailView = document.getElementById('v-subject-detail');
    if (detailView) detailView.classList.remove('act');
    
    const targetViewEl = document.getElementById('v-' + v);
    if (targetViewEl) targetViewEl.classList.add('act');
    
    if (el) {
        el.classList.add('act');
    } else {
        // Activate bottom navigation tab based on v
        let tabIndex = 0;
        if (v === 'subjects') tabIndex = 1;
        else if (v === 'insights') tabIndex = 3;
        else if (v === 'settings') tabIndex = 4;
        const tabs = document.querySelectorAll('.ntab');
        if (tabs[tabIndex]) tabs[tabIndex].classList.add('act');
    }

    if (v === 'overview') renderDashboard();
    if (v === 'subjects') renderSubjects();
    if (v === 'insights') renderInsights();
    if (v === 'settings') renderSettingsPage();

    if (pushToHistory && isNewView) {
        initializeHistoryState();
        history.pushState({ view: v, subjectName: null }, '');
    }
}

// ===== SUBJECT DETAIL & TREND CHART CONTROLLER =====
let currentSubjectName = '';
let showFullHistory = false;

function showSubjectDetail(subjectName, pushToHistory = true) {
    currentSubjectName = subjectName;
    showFullHistory = false;
    
    document.querySelectorAll('.view').forEach(x => x.classList.remove('act'));
    document.getElementById('v-subject-detail').classList.add('act');
    
    renderSubjectDetail(subjectName);

    if (pushToHistory) {
        initializeHistoryState();
        history.pushState({ view: 'subject-detail', subjectName: subjectName }, '');
    }
}

function closeSubjectDetail() {
    if (history.state && history.state.view === 'subject-detail') {
        history.back();
    } else {
        go('subjects', null, true);
    }
}

function renderSubjectDetail(subjectName) {
    // Find subject summary
    const subSummary = summaryData.find(s => s.subject_name === subjectName);
    if (!subSummary) return;
    
    document.getElementById('detailSubjectName').textContent = subSummary.subject_name;
    document.getElementById('detailSubjectCode').textContent = 'AccSoft Synced Course';
    document.getElementById('detailSubjectPerc').textContent = `${subSummary.percentage.toFixed(1)}%`;
    
    // Ring progress
    const ring = document.getElementById('detailSubjectSvgRing');
    const label = document.getElementById('detailSubjectSvgLabel');
    if (ring && label) {
        const offset = 263.89 - (263.89 * Math.min(subSummary.percentage, 100)) / 100;
        ring.setAttribute('stroke-dashoffset', offset);
        const color = subSummary.percentage >= 75 ? 'var(--green)' : subSummary.percentage >= 65 ? 'var(--orange)' : 'var(--red)';
        ring.setAttribute('stroke', color);
        label.textContent = `${Math.round(subSummary.percentage)}%`;
    }

    const badge = document.getElementById('detailSubjectStatus');
    if (badge) {
        const color = subSummary.percentage >= 75 ? 'safe' : subSummary.percentage >= 65 ? 'warning' : 'critical';
        badge.className = `hero-badge ${color}`;
        badge.textContent = subSummary.percentage >= 75 ? 'Good' : subSummary.percentage >= 65 ? 'Warning' : 'Critical';
    }

    // Grid stats
    document.getElementById('detailClassesHeld').textContent = subSummary.held;
    document.getElementById('detailClassesPresent').textContent = subSummary.present;
    document.getElementById('detailClassesAbsent').textContent = subSummary.absent;

    // Recovery Recommendation Calculations
    const recCard = document.getElementById('detailRecoveryCard');
    const recText = document.getElementById('detailRecoveryText');
    if (recCard && recText) {
        const held = subSummary.held;
        const present = subSummary.present;
        const percentage = subSummary.percentage;

        if (percentage >= 75) {
            const safeBunk = Math.floor((present - 0.75 * held) / 0.75);
            recCard.className = 'recover-card good';
            if (safeBunk > 0) {
                recText.textContent = `Awesome! You can miss ${safeBunk} classes safely to stay above 75% target.`;
            } else {
                recText.textContent = `Borderline safe. Do not miss your next class to stay above 75%.`;
            }
        } else {
            const mustAttend = Math.ceil((0.75 * held - present) / 0.25);
            recCard.className = 'recover-card critical';
            if (mustAttend > 0) {
                recText.textContent = `Action Required: Attend ${mustAttend} consecutive classes to recover to 75% target.`;
            } else {
                recText.textContent = `Critical attendance. Attend your next classes to recover.`;
            }
        }
    }

    // Filter subject logs
    const subjectLogs = logsData.filter(l => l.subject_name === subjectName);
    
    // Sort logs chronologically by date ascending for trend calculation
    const chronologicalLogs = [...subjectLogs].sort((a, b) => new Date(a.attendance_date) - new Date(b.attendance_date));
    
    // Draw SVG Trend Chart
    drawTrendChart(chronologicalLogs, 'subjectTrendChart');

    // Populate logs history (sort descending for recent log preview)
    const recentLogs = [...subjectLogs].sort((a, b) => new Date(b.attendance_date) - new Date(a.attendance_date));
    renderLogsList(recentLogs);
}

function renderLogsList(logs) {
    const container = document.getElementById('detailSubjectLogsContainer');
    const btn = document.getElementById('toggleFullHistoryBtn');
    if (!container) return;

    container.innerHTML = '';
    
    if (logs.length === 0) {
        container.innerHTML = '<div class="empty-state-sub" style="text-align:center; padding:12px 0;">No session history found for this subject.</div>';
        if (btn) btn.style.display = 'none';
        return;
    }

    if (btn) btn.style.display = 'block';

    const limit = showFullHistory ? logs.length : Math.min(5, logs.length);
    if (btn) {
        btn.textContent = showFullHistory ? 'Show Less' : 'View Full History';
    }

    for (let i = 0; i < limit; i++) {
        const l = logs[i];
        const row = document.createElement('div');
        row.className = 'hist-item';
        
        const isPresent = l.status === 'P' || l.status.toUpperCase() === 'PRESENT';
        const formattedDate = fmtDateTime(l.attendance_date).split(',')[0]; // get Day Month Year

        row.innerHTML = `
            <div class="hist-item-left">
                <span class="hist-item-date">${formattedDate}</span>
                <span class="hist-item-period">Period ${l.period_no || '--'}</span>
            </div>
            <div class="hist-badge ${isPresent ? 'present' : 'absent'}">${l.status}</div>
        `;
        container.appendChild(row);
    }
}

function toggleFullHistory() {
    showFullHistory = !showFullHistory;
    const subjectLogs = logsData.filter(l => l.subject_name === currentSubjectName);
    const recentLogs = [...subjectLogs].sort((a, b) => new Date(b.attendance_date) - new Date(a.attendance_date));
    renderLogsList(recentLogs);
}

function drawTrendChart(subjectLogs, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    if (subjectLogs.length < 2) {
        container.innerHTML = '<div style="height:100%; display:flex; align-items:center; justify-content:center; color:var(--text-sec); font-size:0.76rem;">Need at least 2 sessions to show trend chart</div>';
        return;
    }

    // Calculate running percentage points
    let runningPresent = 0;
    let runningHeld = 0;
    const points = [];

    subjectLogs.forEach((log) => {
        runningHeld++;
        const isPresent = log.status === 'P' || log.status.toUpperCase() === 'PRESENT';
        if (isPresent) {
            runningPresent++;
        }
        const pct = (runningPresent / runningHeld) * 100;
        points.push(pct);
    });

    const w = 320;
    const h = 130;
    const paddingLeft = 25;
    const paddingRight = 10;
    const paddingTop = 10;
    const paddingBottom = 20;

    const chartW = w - paddingLeft - paddingRight;
    const chartH = h - paddingTop - paddingBottom;

    // Build SVG
    let svgHtml = `<svg viewBox="0 0 ${w} ${h}">
        <defs>
            <linearGradient id="chart-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="var(--primary)" stop-opacity="0.25"/>
                <stop offset="100%" stop-color="var(--primary)" stop-opacity="0.0"/>
            </linearGradient>
        </defs>
        
        <!-- Y Grid lines & labels (50%, 75%, 100%) -->
        <line x1="${paddingLeft}" y1="${paddingTop}" x2="${w - paddingRight}" y2="${paddingTop}" class="chart-grid-line" />
        <text x="5" y="${paddingTop + 3}" class="chart-label">100%</text>

        <line x1="${paddingLeft}" y1="${paddingTop + chartH * 0.25}" x2="${w - paddingRight}" y2="${paddingTop + chartH * 0.25}" class="chart-grid-line" style="stroke: rgba(46, 204, 113, 0.2); stroke-dasharray:none;" />
        <text x="5" y="${paddingTop + chartH * 0.25 + 3}" class="chart-label" style="fill: var(--green);">75%</text>

        <line x1="${paddingLeft}" y1="${paddingTop + chartH * 0.5}" x2="${w - paddingRight}" y2="${paddingTop + chartH * 0.5}" class="chart-grid-line" />
        <text x="5" y="${paddingTop + chartH * 0.5 + 3}" class="chart-label">50%</text>

        <line x1="${paddingLeft}" y1="${h - paddingBottom}" x2="${w - paddingRight}" y2="${h - paddingBottom}" style="stroke: var(--border); stroke-width: 1.5px;" />
    `;

    // Coordinates mapping
    const n = points.length;
    const coords = [];
    points.forEach((pct, idx) => {
        const x = paddingLeft + (idx / (n - 1)) * chartW;
        const y = paddingTop + chartH - (pct / 100) * chartH;
        coords.push({ x, y });
    });

    let linePath = `M ${coords[0].x} ${coords[0].y}`;
    let areaPath = `M ${coords[0].x} ${coords[0].y}`;
    
    for (let i = 1; i < coords.length; i++) {
        linePath += ` L ${coords[i].x} ${coords[i].y}`;
        areaPath += ` L ${coords[i].x} ${coords[i].y}`;
    }
    
    areaPath += ` L ${coords[coords.length - 1].x} ${h - paddingBottom} L ${coords[0].x} ${h - paddingBottom} Z`;

    svgHtml += `
        <path d="${areaPath}" class="chart-area" />
        <path d="${linePath}" class="chart-line" />
    `;

    // Draw last point circle
    const lastCoord = coords[coords.length - 1];
    svgHtml += `<circle cx="${lastCoord.x}" cy="${lastCoord.y}" r="4" class="chart-point" />`;

    // Add Date Labels on X Axis (first and last date)
    const firstDate = fmtDateTime(subjectLogs[0].attendance_date).split(',')[0];
    const lastDate = fmtDateTime(subjectLogs[subjectLogs.length - 1].attendance_date).split(',')[0];

    svgHtml += `
        <text x="${paddingLeft}" y="${h - 5}" class="chart-label">${firstDate}</text>
        <text x="${w - paddingRight}" y="${h - 5}" class="chart-label" text-anchor="end">${lastDate}</text>
    </svg>`;

    container.innerHTML = svgHtml;
}

function toggleSettingsMenu() {
    const settingsView = document.getElementById('v-settings');
    const isSettingsActive = settingsView && settingsView.classList.contains('act');
    
    if (isSettingsActive) {
        // Go back to overview (Home)
        go('overview', document.querySelectorAll('.ntab')[0]);
    } else {
        // Go to settings tab
        go('settings', document.querySelectorAll('.ntab')[4]);
    }
}

// ===== HELPER FUNCTIONS =====
const fmtD = d => {
    const p = d.split('-');
    return p[2] + '/' + p[1];
};

function fmtDateTime(isoStr) {
    const d = new Date(isoStr);
    const day = String(d.getDate()).padStart(2, '0');
    const month = d.toLocaleString('default', { month: 'short' });
    const year = d.getFullYear();
    let hours = d.getHours();
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12; // the hour '0' should be '12'
    return `${day} ${month} ${year}, ${hours}:${minutes} ${ampm}`;
}

function getGreeting() {
    const hour = new Date().getHours();
    if (hour < 12) return 'GOOD MORNING,';
    if (hour < 17) return 'GOOD AFTERNOON,';
    return 'GOOD EVENING,';
}

function getUserFriendlyName(user) {
    if (!user) return 'Student';
    if (user.user_metadata && user.user_metadata.full_name) {
        return user.user_metadata.full_name;
    }
    if (user.user_metadata && user.user_metadata.name) {
        return user.user_metadata.name;
    }
    if (user.email) {
        const username = user.email.split('@')[0];
        const parts = username.split(/[\._\-]/);
        const formattedName = parts.map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join(' ');
        return formattedName;
    }
    return 'Student';
}

function updateWelcomeHeader(userObj = currentUser) {
    const welcomeEl = document.getElementById('headerWelcome');
    const greetingEl = document.getElementById('headerGreeting');
    if (welcomeEl && userObj) {
        welcomeEl.textContent = getUserFriendlyName(userObj);
    }
    if (greetingEl) {
        greetingEl.textContent = getGreeting();
    }
}

function timeAgo(dateString) {
    if (!dateString) return 'Never';
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    return `${diffDays}d ago`;
}

function toast(m) {
    const t = document.getElementById('toast');
    if (t) {
        t.textContent = m;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 3000);
    }
}

// ===== PWA SERVICE WORKER REGISTRATION & LIFE CYCLE =====
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./service-worker.js')
            .then(reg => {
                console.log('[PWA] Service Worker registered with scope:', reg.scope);
                
                // Handle SW updates and skip waiting reload
                reg.onupdatefound = () => {
                    const installingWorker = reg.installing;
                    if (installingWorker) {
                        installingWorker.onstatechange = () => {
                            if (installingWorker.state === 'installed') {
                                if (navigator.serviceWorker.controller) {
                                    console.log('[PWA] New version detected, activating...');
                                    installingWorker.postMessage('skipWaiting');
                                } else {
                                    console.log('[PWA] Content cached offline.');
                                }
                            }
                        };
                    }
                };
            })
            .catch(err => {
                console.error('[PWA] Service Worker registration failed:', err);
            });
    });

    // Reload active tab when new worker takes over
    let refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!refreshing) {
            refreshing = true;
            console.log('[PWA] Controller changed, reloading page...');
            window.location.reload();
        }
    });
}

// ===== PWA INSTALL EXPERIENCE INTERCEPTOR =====
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
    // Prevent the default browser prompt banner from showing automatically
    e.preventDefault();
    deferredPrompt = e;
    
    // Show the custom install button inside settings menu
    const installItem = document.getElementById('pwaInstallItem');
    if (installItem) {
        installItem.style.display = 'flex';
        installItem.onclick = async () => {
            if (deferredPrompt) {
                deferredPrompt.prompt();
                const { outcome } = await deferredPrompt.userChoice;
                console.log(`[PWA] User response to installation prompt: ${outcome}`);
                deferredPrompt = null;
                installItem.style.display = 'none';
            }
        };
    }
});

window.addEventListener('appinstalled', (e) => {
    console.log('[PWA] AttendEase installed successfully.');
    const installItem = document.getElementById('pwaInstallItem');
    if (installItem) {
        installItem.style.display = 'none';
    }
    toast("🎉 AttendEase installed successfully on your device!");
});
