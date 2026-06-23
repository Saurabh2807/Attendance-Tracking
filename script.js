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

// Unified session state handler with idempotency guard
async function handleSessionState(session) {
    const userId = session && session.user ? session.user.id : null;
    
    if (userId === processedUserId) {
        console.log(`[SESSION] User ID ${userId || 'guest'} is already processed. Skipping duplicate handler.`);
        return;
    }
    
    processedUserId = userId;
    currentUser = session ? session.user : null;
    
    console.log(`[SESSION] Processing state for user ID: ${userId || 'guest'}`);
    
    if (currentUser) {
        if (isInitializing) {
            console.log("[SESSION] Already processing initial boot check. Skipping nested load.");
            return;
        }
        isInitializing = true;
        
        try {
            pendingInitStep = 'load-user-profile';
            await checkConnectionAndLoadData();
            pendingInitStep = 'complete';
        } catch (err) {
            console.error("[SESSION] Error during user profile or database loading:", err);
            handleInitializationFailure(err);
        } finally {
            isInitializing = false;
        }
    } else {
        console.log("[SESSION] No active session found. Routing to Login Screen.");
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
    console.log("[BOOT] DOMContentLoaded event fired.");
    
    // Light/Dark Theme Restore
    try {
        const isLight = localStorage.getItem('ae_theme') === 'lm';
        if (isLight) {
            document.body.classList.add('lm');
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
            console.error(`[SPLASH] Timeout triggered. Pending Step: ${pendingInitStep}`);
            handleInitializationFailure(new Error(`Startup timed out at step: ${pendingInitStep}`));
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
            console.log(`[AUTH] Auth state changed event received: ${event}`, session);
            try {
                await handleSessionState(session);
            } catch (err) {
                console.error("[AUTH] Error processing auth state change event:", err);
                handleInitializationFailure(err);
            }
        });
    } catch (err) {
        console.error("[AUTH] Failed to register onAuthStateChange listener:", err);
        handleInitializationFailure(err);
        return;
    }

    // Explicitly call getSession() to handle fast session restoration
    try {
        console.log("[SESSION] Verifying session via getSession()...");
        const { data: { session }, error } = await supabaseClient.auth.getSession();
        if (error) {
            console.error("[SESSION] getSession() call returned error:", error);
            throw error;
        }
        console.log("[SESSION] getSession() completed. Session found:", !!session);
        try {
            await handleSessionState(session);
        } catch (err) {
            console.error("[SESSION] Error handling manual getSession state:", err);
            handleInitializationFailure(err);
        }
    } catch (err) {
        console.error("[SESSION] Failed to query session via getSession():", err);
        handleInitializationFailure(err);
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
    try {
        const redirectUrl = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
            ? window.location.origin + window.location.pathname
            : 'https://saurabh2807.github.io/Attendance-Tracking/';

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
async function checkConnectionAndLoadData() {
    try {
        console.log("[PROFILE] Checking user connection status in database...");
        // Fetch connection record
        const { data: conn, error } = await supabaseClient
            .from('accsoft_connections')
            .select('*')
            .eq('user_id', currentUser.id)
            .maybeSingle();

        if (error) {
            console.error("[PROFILE] Database query error for accsoft_connections:", error);
            throw error;
        }

        connectionData = conn;

        if (!conn) {
            console.log("[PROFILE] User has no AccSoft connection record. Redirecting to connect screen.");
            showAuthTab('connect');
            isAppReady = true;
            checkAndHideSplash();
        } else {
            console.log("[PROFILE] User has AccSoft connection. Loading dashboard...");
            document.getElementById('ob').style.display = 'none';
            document.getElementById('app').style.display = 'flex';
            
            // Set header labels
            const name = currentUser.user_metadata?.full_name || 'Student';
            document.getElementById('headerWelcome').textContent = `Hi, ${name} 👋`;
            
            // Refresh local state lists
            pendingInitStep = 'load-attendance-data';
            await refreshData();
        }
        isAppReady = true;
        checkAndHideSplash();
    } catch (err) {
        console.error("[PROFILE] Error checking connection status:", err);
        if (!isAppReady) {
            // Fail-safe redirect during initial load sequence
            handleInitializationFailure(err);
        } else {
            toast("⚠️ Connection error. Please check your network.");
            
            // Show retry button on splash screen instead of logging them out
            const loader = document.querySelector('.splash-loader');
            if (loader) loader.style.display = 'none';
            const retryBox = document.getElementById('splashRetry');
            if (retryBox) retryBox.style.display = 'block';
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
    const connStepLogin = document.getElementById('connStepLogin');
    const connStepFetch = document.getElementById('connStepFetch');
    const connStepSave = document.getElementById('connStepSave');

    if (connectLoading) connectLoading.style.display = 'flex';
    if (connStepLogin) {
        connStepLogin.className = 'loading-step active';
        connStepLogin.querySelector('.step-indicator').innerHTML = '<div class="spin-circle"></div>';
    }
    if (connStepFetch) {
        connStepFetch.className = 'loading-step';
        connStepFetch.querySelector('.step-indicator').textContent = '⏳';
    }
    if (connStepSave) {
        connStepSave.className = 'loading-step';
        connStepSave.querySelector('.step-indicator').textContent = '⏳';
    }

    toast("⏳ Connecting account (Verifying credentials)...");
    
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

        if (connStepLogin) {
            connStepLogin.className = 'loading-step success';
            connStepLogin.querySelector('.step-indicator').textContent = '✅';
        }
        if (connStepFetch) {
            connStepFetch.className = 'loading-step success';
            connStepFetch.querySelector('.step-indicator').textContent = '✅';
        }
        if (connStepSave) {
            connStepSave.className = 'loading-step success';
            connStepSave.querySelector('.step-indicator').textContent = '✅';
        }

        toast("✅ Connected successfully!");
        
        // Refresh connection details locally and trigger automated sync
        await checkConnectionAndLoadData();
        await triggerSyncNow();

    } catch (err) {
        if (connStepLogin) {
            connStepLogin.className = 'loading-step failed';
            connStepLogin.querySelector('.step-indicator').textContent = '❌';
        }
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

    toast("⏳ Disconnecting...");
    try {
        const { error } = await supabaseClient
            .from('accsoft_connections')
            .delete()
            .eq('user_id', currentUser.id);

        if (error) throw error;

        toast("🗑️ Disconnected portal successfully");
        await checkConnectionAndLoadData();
    } catch (err) {
        toast(`Error: ${err.message}`);
    }
}

// ===== ATTENDANCE MANUAL SYNC PIPELINE =====
async function triggerSyncNow() {
    const modal = document.getElementById('syncingModal');
    const stepLogin = document.getElementById('syncStepLogin');
    const stepFetch = document.getElementById('syncStepFetch');
    const stepSave = document.getElementById('syncStepSave');
    const bar = document.getElementById('syncProgressBar');
    const text = document.getElementById('syncProgressText');

    // Reset Sync Progress UI
    modal.classList.remove('hidden');
    stepLogin.textContent = '⏳ Log in to AccSoft';
    stepLogin.style.color = 'var(--text3)';
    stepFetch.textContent = '⏳ Fetching attendance data';
    stepFetch.style.color = 'var(--text3)';
    stepSave.textContent = '⏳ Saving to database';
    stepSave.style.color = 'var(--text3)';
    bar.style.width = '0%';
    text.textContent = '0 / 3';

    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) {
        modal.classList.add('hidden');
        toast("Session expired. Please log in again.");
        return;
    }

    // Step 1: Login progress transition
    setTimeout(() => {
        stepLogin.textContent = '🔄 Logging in to AccSoft...';
        stepLogin.style.color = 'var(--yellow)';
        bar.style.width = '15%';
        text.textContent = '0.5 / 3';
    }, 400);

    try {
        // Trigger manual sync API
        const response = await fetch(`${window.SYNC_SERVICE_URL}/sync-attendance`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${session.access_token}`
            }
        });

        const resData = await response.json();
        
        if (!response.ok) {
            throw new Error(resData.error || 'Synchronization failed');
        }

        // Fast forward animations to success state
        stepLogin.textContent = '✅ Logged in to AccSoft';
        stepLogin.style.color = 'var(--green)';
        bar.style.width = '33%';
        
        stepFetch.textContent = '✅ Fetching attendance data';
        stepFetch.style.color = 'var(--green)';
        bar.style.width = '66%';
        
        stepSave.textContent = '✅ Saving to database';
        stepSave.style.color = 'var(--green)';
        bar.style.width = '100%';
        text.textContent = '3 / 3';

        setTimeout(() => {
            modal.classList.add('hidden');
            toast("✅ Sync completed successfully!");
            refreshData();
        }, 1000);

    } catch (err) {
        console.error("Sync failed:", err);
        modal.classList.add('hidden');
        toast(`❌ ${err.message}`);
        await refreshData(); // Refresh to update error message on connection state card
    }
}

// ===== DATABASE REFRESH & STATE MANAGEMENT =====
// ===== DATABASE REFRESH & STATE MANAGEMENT =====
async function refreshData() {
    try {
        console.log("[DASHBOARD] Refreshing local cached attendance data from database...");
        
        // Fetch connection record again
        const { data: conn, error: connErr } = await supabaseClient
            .from('accsoft_connections')
            .select('*')
            .eq('user_id', currentUser.id)
            .single();

        if (connErr) throw connErr;
        connectionData = conn;

        // Update welcome card subtext (Last Sync time)
        const lastSyncEl = document.getElementById('headerLastSync');
        if (lastSyncEl) {
            if (connectionData) {
                const lastSyncStr = connectionData.last_sync_at ? fmtDateTime(connectionData.last_sync_at) : 'Never';
                lastSyncEl.textContent = `Last Sync: ${lastSyncStr}`;
            } else {
                lastSyncEl.textContent = 'Not Connected';
            }
        }

        // Fetch Summary
        const { data: summaries, error: sumErr } = await supabaseClient
            .from('attendance_summary')
            .select('*')
            .eq('user_id', currentUser.id)
            .order('subject_name');

        if (sumErr) throw sumErr;
        summaryData = summaries || [];

        // Fetch logs
        const { data: logs, error: logsErr } = await supabaseClient
            .from('attendance_logs')
            .select('*')
            .eq('user_id', currentUser.id)
            .order('attendance_date', { ascending: false })
            .order('period_no', { ascending: true });

        if (logsErr) throw logsErr;
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
        console.log("[DASHBOARD] All UI elements successfully rendered.");

    } catch (err) {
        console.error("[DASHBOARD] Data refresh failed:", err);
        toast("⚠️ Failed to load attendance data");
        // Re-throw if in initial load so loader gets notified of the failure
        if (!isAppReady) {
            throw err;
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
    const subjList = document.getElementById('dashSubjectList');
    
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
    const ringOffset = 201.06 - (201.06 * Math.min(overallPerc, 100) / 100);

    // Overall Ring Card Updates
    document.getElementById('dashOverallPerc').textContent = `${overallPerc.toFixed(1)}%`;
    const ring = document.getElementById('dashOverallSvgRing');
    ring.setAttribute('stroke-dashoffset', ringOffset);
    
    // Color code ring and text
    const ringCol = overallPerc >= 75 ? 'var(--green)' : overallPerc >= 65 ? 'var(--orange)' : 'var(--red)';
    ring.setAttribute('stroke', ringCol);
    document.getElementById('dashOverallPerc').style.color = ringCol;
    
    const label = document.getElementById('dashOverallSvgLabel');
    if (label) {
        label.textContent = `${Math.round(overallPerc)}%`;
        label.style.color = ringCol;
    }

    // Set feedback label
    const feedbackLbl = document.getElementById('dashOverallStatus');
    const helpText = document.getElementById('dashOverallHelpText');
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

    // Render Quick Subject Overview
    subjList.innerHTML = '';
    summaryData.slice(0, 3).forEach(s => {
        const percCol = s.percentage >= 75 ? 'var(--green)' : s.percentage >= 65 ? 'var(--orange)' : 'var(--red)';
        const row = document.createElement('div');
        row.className = 'subj-row';
        row.onclick = () => showSubjectDetail(s.subject_name);
        row.innerHTML = `
            <div class="subj-row-top">
                <div class="subj-row-info">
                    <div class="subj-row-icon">📚</div>
                    <div class="subj-row-details">
                        <div class="subj-row-name">${s.subject_name}</div>
                        <div class="subj-row-stats">Attended <span class="pres">${s.present}</span>/${s.held}</div>
                    </div>
                </div>
                <div class="subj-row-perc" style="color: ${percCol};">${s.percentage.toFixed(1)}%</div>
                <div class="subj-row-arrow">></div>
            </div>
            <div class="subj-row-progress">
                <div class="subj-row-fill" style="width: ${s.percentage}%; background: ${percCol};"></div>
            </div>
        `;
        subjList.appendChild(row);
    });
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
        const card = document.createElement('div');
        card.className = 'subj-row';
        card.onclick = () => showSubjectDetail(s.subject_name);
        card.innerHTML = `
            <div class="subj-row-top">
                <div class="subj-row-info">
                    <div class="subj-row-icon">📚</div>
                    <div class="subj-row-details">
                        <div class="subj-row-name">${s.subject_name}</div>
                        <div class="subj-row-stats">Held: <span>${s.held}</span> • Attended: <span class="pres">${s.present}</span> • Missed: <span class="abs">${s.absent}</span></div>
                    </div>
                </div>
                <div class="subj-row-perc" style="color: ${percCol};">${s.percentage.toFixed(1)}%</div>
                <div class="subj-row-arrow">></div>
            </div>
            <div class="subj-row-progress">
                <div class="subj-row-fill" style="width: ${s.percentage}%; background: ${percCol};"></div>
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
                card.className = 'insight-card';
                card.style.borderColor = 'rgba(46, 204, 113, 0.2)';
                card.style.background = 'var(--green-dim)';
                card.onclick = () => showSubjectDetail(s.subject_name);
                card.innerHTML = `
                    <div class="insight-left">
                        <span class="insight-tag" style="color: var(--green);">Bunk Prediction</span>
                        <span class="insight-title" style="color: var(--green);">${safeBunk} classes</span>
                        <span class="insight-sub">Safe to skip in ${s.subject_name}</span>
                    </div>
                    <div class="insight-right">🎯</div>
                `;
                container.appendChild(card);
            }
        } else {
            // Calculate must attend
            const mustAttend = Math.ceil((0.75 * s.held - s.present) / 0.25);
            if (mustAttend > 0) {
                const card = document.createElement('div');
                card.className = 'insight-card';
                card.style.borderColor = 'rgba(231, 76, 60, 0.2)';
                card.style.background = 'var(--red-dim)';
                card.onclick = () => showSubjectDetail(s.subject_name);
                card.innerHTML = `
                    <div class="insight-left">
                        <span class="insight-tag" style="color: var(--red);">Attendance Goal</span>
                        <span class="insight-title" style="color: var(--red);">${mustAttend} consecutive</span>
                        <span class="insight-sub">Must attend classes in ${s.subject_name}</span>
                    </div>
                    <div class="insight-right">⚠️</div>
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
        card.className = 'insight-card';
        card.style.borderColor = 'rgba(230, 126, 34, 0.2)';
        card.style.background = 'var(--orange-dim)';
        card.onclick = () => showSubjectDetail(lowestSub.subject_name);
        card.innerHTML = `
            <div class="insight-left">
                <span class="insight-tag" style="color: var(--orange);">Lowest Attendance</span>
                <span class="insight-title" style="color: var(--orange);">${lowestSub.subject_name}</span>
                <span class="insight-sub">Has your lowest attendance (${lowestPerc.toFixed(1)}%). Try to improve!</span>
            </div>
            <div class="insight-right">📈</div>
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
        if (enrollLbl) enrollLbl.textContent = 'Enrollment: Not Connected';
        if (badge) {
            badge.textContent = 'Disconnected';
            badge.className = 'hero-badge critical';
        }
        if (syncLbl) syncLbl.textContent = 'Last Synced: Never';
    } else {
        if (enrollLbl) enrollLbl.textContent = `Enrollment: ${connectionData.enrollment_no}`;
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

function go(v, el) {
    document.querySelectorAll('.view').forEach(x => x.classList.remove('act'));
    document.querySelectorAll('.ntab').forEach(x => x.classList.remove('act'));
    
    // Hide subject detail explicitly if going to another tab
    const detailView = document.getElementById('v-subject-detail');
    if (detailView) detailView.classList.remove('act');
    
    document.getElementById('v-' + v).classList.add('act');
    el.classList.add('act');

    if (v === 'overview') renderDashboard();
    if (v === 'subjects') renderSubjects();
    if (v === 'insights') renderInsights();
    if (v === 'settings') renderSettingsPage();
}

// ===== SUBJECT DETAIL & TREND CHART CONTROLLER =====
let currentSubjectName = '';
let showFullHistory = false;

function showSubjectDetail(subjectName) {
    currentSubjectName = subjectName;
    showFullHistory = false;
    
    document.querySelectorAll('.view').forEach(x => x.classList.remove('act'));
    document.getElementById('v-subject-detail').classList.add('act');
    
    renderSubjectDetail(subjectName);
}

function closeSubjectDetail() {
    document.getElementById('v-subject-detail').classList.remove('act');
    document.getElementById('v-subjects').classList.add('act');
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
        const offset = 201.06 - (201.06 * Math.min(subSummary.percentage, 100)) / 100;
        ring.setAttribute('stroke-dashoffset', offset);
        const color = subSummary.percentage >= 75 ? 'var(--green)' : subSummary.percentage >= 65 ? 'var(--orange)' : 'var(--red)';
        ring.setAttribute('stroke', color);
        label.textContent = `${Math.round(subSummary.percentage)}%`;
        label.style.color = color;
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

function toast(m) {
    const t = document.getElementById('toast');
    if (t) {
        t.textContent = m;
        t.classList.add('show');
        setTimeout(() => t.classList.remove('show'), 3000);
    }
}
