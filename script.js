// ===== CONSTANTS & GLOBAL STATE =====
let supabaseClient = null;
let currentUser = null;
let connectionData = null;
let summaryData = [];
let logsData = [];

// Navigation mapping
const DNAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ===== INIT =====
window.addEventListener('DOMContentLoaded', async () => {
    // Light/Dark Theme Restore
    if (localStorage.getItem('ae_theme') === 'lm') {
        document.body.classList.add('lm');
        document.getElementById('themeBtn').textContent = '☀️';
    }

    // Verify Supabase Config is present
    if (!window.SUPABASE_URL || !window.SUPABASE_ANON_KEY) {
        toast("⚠️ Supabase config.js parameters missing!");
        showWelcomeScreen();
        return;
    }

    // Initialize Supabase
    try {
        supabaseClient = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
    } catch (err) {
        console.error("Supabase initialization error:", err);
        toast("❌ Failed to initialize Supabase. Check config settings.");
    }

    // Set up auth listener
    supabaseClient.auth.onAuthStateChange(async (event, session) => {
        console.log("Auth State Changed:", event, session);
        currentUser = session ? session.user : null;
        
        if (currentUser) {
            // User logged in
            await checkConnectionAndLoadData();
        } else {
            // User logged out
            showWelcomeScreen();
        }
    });
});

// ===== AUTHENTICATION LIFE CYCLE =====
function showWelcomeScreen() {
    document.getElementById('ob').style.display = 'flex';
    document.getElementById('ob').style.flexDirection = 'column';
    document.getElementById('app').style.display = 'none';
    showAuthTab('welcome');
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
    }
}

async function handleSignUp() {
    const name = document.getElementById('signUpName').value.trim();
    const email = document.getElementById('signUpEmail').value.trim();
    const pass = document.getElementById('signUpPass').value;

    if (!name || !email || !pass) {
        toast("❌ Please fill in all fields");
        return;
    }

    toast("⏳ Signing up...");
    const { data, error } = await supabaseClient.auth.signUp({
        email,
        password: pass,
        options: {
            data: {
                full_name: name
            }
        }
    });

    if (error) {
        toast(`❌ Sign up failed: ${error.message}`);
    } else {
        toast("✅ Sign up successful! Logging you in...");
    }
}

async function handleLogin() {
    const email = document.getElementById('loginEmail').value.trim();
    const pass = document.getElementById('loginPass').value;

    if (!email || !pass) {
        toast("❌ Please fill in all fields");
        return;
    }

    toast("⏳ Logging in...");
    const { data, error } = await supabaseClient.auth.signInWithPassword({
        email,
        password: pass
    });

    if (error) {
        toast(`❌ Login failed: ${error.message}`);
    } else {
        toast("✅ Welcome back!");
    }
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

// ===== ACCSOFT PORTAL LOGINS =====
async function checkConnectionAndLoadData() {
    try {
        // Fetch connection record
        const { data: conn, error } = await supabaseClient
            .from('accsoft_connections')
            .select('*')
            .eq('user_id', currentUser.id)
            .maybeSingle();

        if (error) throw error;

        connectionData = conn;

        if (!conn) {
            // Not connected to Accsoft
            showAuthTab('connect');
        } else {
            // Account is connected - transition to main application layout
            document.getElementById('ob').style.display = 'none';
            document.getElementById('app').style.display = 'block';
            
            // Set header labels
            const name = currentUser.user_metadata?.full_name || 'Student';
            document.getElementById('headerWelcome').textContent = `Hello, ${name} 👋`;
            
            // Refresh local state lists
            await refreshData();
        }
    } catch (err) {
        console.error("Error checking connection status:", err);
        toast("⚠️ Error loading account configuration");
    }
}

async function handleConnectAccsoft() {
    const enroll = document.getElementById('accsoftEnroll').value.trim();
    const pass = document.getElementById('accsoftPass').value;

    if (!enroll || !pass) {
        toast("❌ Please enter both fields");
        return;
    }

    toast("⏳ Connecting account (Verifying credentials)...");
    
    // Retrieve user session token
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (!session) {
        toast("Session expired. Please log in again.");
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
        
        // Refresh connection details locally and trigger automated sync
        await checkConnectionAndLoadData();
        await triggerSyncNow();

    } catch (err) {
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
async function refreshData() {
    try {
        // Fetch connection record again
        const { data: conn } = await supabaseClient
            .from('accsoft_connections')
            .select('*')
            .eq('user_id', currentUser.id)
            .single();

        connectionData = conn;

        // Fetch Summary
        const { data: summaries } = await supabaseClient
            .from('attendance_summary')
            .select('*')
            .eq('user_id', currentUser.id)
            .order('subject_name');

        summaryData = summaries || [];

        // Fetch logs
        const { data: logs } = await supabaseClient
            .from('attendance_logs')
            .select('*')
            .eq('user_id', currentUser.id)
            .order('attendance_date', { ascending: false })
            .order('period_no', { ascending: true });

        logsData = logs || [];

        // Render UI panels
        updateSyncStatusStrip();
        renderDashboard();
        renderSubjects();
        populateHistoryFilters();
        renderHistory();
        renderInsights();
        renderSettingsPage();

    } catch (err) {
        console.error("Data refresh failed:", err);
        toast("⚠️ Failed to load attendance data");
    }
}

function updateSyncStatusStrip() {
    const dot = document.getElementById('syncStatusDot');
    const lbl = document.getElementById('syncStatusLbl');
    const btn = document.getElementById('syncBtn');

    if (!connectionData) return;

    const lastSyncStr = connectionData.last_sync_at ? fmtDateTime(connectionData.last_sync_at) : 'Never';

    if (connectionData.last_sync_status === 'SUCCESS') {
        dot.style.background = 'var(--green)';
        lbl.textContent = `Synced: ${lastSyncStr}`;
        lbl.style.color = 'var(--green)';
        lbl.parentElement.style.background = 'var(--green-dim)';
        lbl.parentElement.style.borderColor = 'rgba(0, 200, 150, 0.2)';
    } else if (connectionData.last_sync_status) {
        dot.style.background = 'var(--red)';
        lbl.textContent = `Sync Failed: ${connectionData.last_sync_status}`;
        lbl.style.color = 'var(--red)';
        lbl.parentElement.style.background = 'var(--red-dim)';
        lbl.parentElement.style.borderColor = 'rgba(255, 69, 96, 0.2)';
    } else {
        dot.style.background = 'var(--yellow)';
        lbl.textContent = 'Never Synced';
        lbl.style.color = 'var(--yellow)';
        lbl.parentElement.style.background = 'var(--yellow-dim)';
        lbl.parentElement.style.borderColor = 'rgba(255, 176, 32, 0.2)';
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
    document.getElementById('dashOverallPerc').textContent = `${overallPerc.toFixed(2)}%`;
    const ring = document.getElementById('dashOverallSvgRing');
    ring.setAttribute('stroke-dashoffset', ringOffset);
    
    // Color code ring and text
    const ringCol = overallPerc >= 75 ? 'var(--green)' : overallPerc >= 65 ? 'var(--yellow)' : 'var(--red)';
    ring.setAttribute('stroke', ringCol);
    document.getElementById('dashOverallPerc').style.color = ringCol;
    document.getElementById('dashOverallSvgLabel').textContent = `${Math.round(overallPerc)}%`;
    document.getElementById('dashOverallSvgLabel').style.color = ringCol;

    // Set feedback label
    const feedbackLbl = document.getElementById('dashOverallStatus');
    if (overallPerc >= 75) {
        feedbackLbl.textContent = "You're doing great! Keep it up.";
        feedbackLbl.style.color = 'var(--green)';
    } else if (overallPerc >= 65) {
        feedbackLbl.textContent = "Borderline. Try not to miss classes.";
        feedbackLbl.style.color = 'var(--yellow)';
    } else {
        feedbackLbl.textContent = "Low attendance. Bunks not allowed!";
        feedbackLbl.style.color = 'var(--red)';
    }

    // Held stats fields
    document.getElementById('dashClassesHeld').textContent = totalHeld;
    document.getElementById('dashClassesPresent').textContent = totalPresent;
    document.getElementById('dashClassesAbsent').textContent = totalAbsent;

    // Render Quick Subject Overview
    subjList.innerHTML = '';
    summaryData.slice(0, 3).forEach(s => {
        const percCol = s.percentage >= 75 ? 'var(--green)' : s.percentage >= 65 ? 'var(--yellow)' : 'var(--red)';
        const row = document.createElement('div');
        row.className = 'subj-card';
        row.style.padding = '12px 14px';
        row.style.marginBottom = '8px';
        row.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 6px;">
                <span style="font-size: 0.8rem; font-weight:700; max-width: 70%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${s.subject_name}</span>
                <span style="color: ${percCol}; font-weight:800; font-size: 0.82rem;">${s.percentage.toFixed(1)}%</span>
            </div>
            <div class="prog" style="height: 4px; margin: 0;">
                <div class="prog-fill" style="width: ${s.percentage}%; background: ${percCol};"></div>
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
        const color = s.percentage >= 75 ? 'var(--green)' : s.percentage >= 65 ? 'var(--yellow)' : 'var(--red)';
        const card = document.createElement('div');
        card.className = 'subj-card';
        card.innerHTML = `
            <div class="subj-top">
                <div>
                    <div class="subj-name">${s.subject_name}</div>
                    <div class="subj-meta">${s.present}/${s.held} attended • ${s.absent} missed</div>
                </div>
                <span class="badge bm">${s.percentage >= 75 ? 'Safe' : s.percentage >= 65 ? 'Warning' : 'Critical'}</span>
            </div>
            <div class="prog">
                <div class="prog-fill" style="width: ${s.percentage}%; background: ${color}"></div>
            </div>
            <div class="subj-foot">
                <span style="color: ${color}; font-weight: 700;">${s.percentage.toFixed(2)}%</span>
                <span style="color: var(--text3)">Target: 75% (${Math.ceil(s.held * 0.75)} present)</span>
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
        container.innerHTML = '<div style="text-align:center; padding: 24px; color: var(--text3); font-size:0.8rem;">No records matching filters</div>';
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

    container.innerHTML = '';

    if (summaryData.length === 0) {
        fallback.style.display = 'block';
        container.style.display = 'none';
        return;
    }

    fallback.style.display = 'none';
    container.style.display = 'block';

    let lowestSub = null;
    let lowestPerc = 101;

    summaryData.forEach(s => {
        if (s.held === 0) return;

        // Check lowest subject
        if (s.percentage < lowestPerc) {
            lowestPerc = s.percentage;
            lowestSub = s;
        }

        const req = Math.ceil(0.75 * s.held);

        if (s.percentage >= 75) {
            // Calculate safe bunks
            const safeBunk = Math.floor((s.present - 0.75 * s.held) / 0.75);
            if (safeBunk > 0) {
                const card = document.createElement('div');
                card.className = 'card';
                card.style.borderColor = 'rgba(0, 200, 150, 0.2)';
                card.style.background = 'var(--green-dim)';
                card.innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <div style="font-size: 0.65rem; font-weight:700; color: var(--green); text-transform:uppercase;">Bunk Prediction</div>
                            <div style="font-size: 1.1rem; font-weight:900; margin-top:4px; color: var(--green);">${safeBunk} classes</div>
                            <div style="font-size: 0.74rem; color: var(--text2); margin-top:2px;">Safe to skip in ${s.subject_name}</div>
                        </div>
                        <div style="font-size: 2rem;">🎯</div>
                    </div>
                `;
                container.appendChild(card);
            }
        } else {
            // Calculate must attend
            const mustAttend = Math.ceil((0.75 * s.held - s.present) / 0.25);
            if (mustAttend > 0) {
                const card = document.createElement('div');
                card.className = 'card';
                card.style.borderColor = 'rgba(255, 69, 96, 0.2)';
                card.style.background = 'var(--red-dim)';
                card.innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <div style="font-size: 0.65rem; font-weight:700; color: var(--red); text-transform:uppercase;">Attendance Goal</div>
                            <div style="font-size: 1.1rem; font-weight:900; margin-top:4px; color: var(--red);">${mustAttend} consecutive</div>
                            <div style="font-size: 0.74rem; color: var(--text2); margin-top:2px;">Must attend classes in ${s.subject_name}</div>
                        </div>
                        <div style="font-size: 2rem;">⚠️</div>
                    </div>
                `;
                container.appendChild(card);
            }
        }
    });

    // Render lowest attendance card
    if (lowestSub) {
        const card = document.createElement('div');
        card.className = 'card';
        card.style.borderColor = 'rgba(255, 176, 32, 0.2)';
        card.style.background = 'var(--yellow-dim)';
        card.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <div>
                    <div style="font-size: 0.65rem; font-weight:700; color: var(--yellow); text-transform:uppercase;">Recommendation</div>
                    <div style="font-size: 1.1rem; font-weight:900; margin-top:4px; color: var(--yellow);">${lowestSub.subject_name}</div>
                    <div style="font-size: 0.74rem; color: var(--text2); margin-top:2px;">Has your lowest attendance (${lowestSub.percentage.toFixed(1)}%). Try to attend!</div>
                </div>
                <div style="font-size: 2rem;">📈</div>
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
        enrollLbl.textContent = 'Enrollment: Not Connected';
        badge.textContent = 'Disconnected';
        badge.className = 'badge bm';
        syncLbl.textContent = 'Last Synced: Never';
    } else {
        enrollLbl.textContent = `Enrollment: ${connectionData.enrollment_no}`;
        badge.textContent = connectionData.last_sync_status === 'SUCCESS' ? 'Connected' : 'Sync Error';
        badge.className = connectionData.last_sync_status === 'SUCCESS' ? 'badge g2b' : 'badge g1b';
        const lastStr = connectionData.last_sync_at ? fmtDateTime(connectionData.last_sync_at) : 'Never';
        syncLbl.textContent = `Last Synced: ${lastStr}`;
    }

    if (currentUser) {
        nameLbl.textContent = currentUser.user_metadata?.full_name || 'Student';
        emailLbl.textContent = currentUser.email || '';
    }
}

// ===== THEME & NAV TOGGLES =====
function toggleTheme() {
    const on = document.body.classList.toggle('lm');
    localStorage.setItem('ae_theme', on ? 'lm' : 'dk');
    document.getElementById('themeBtn').textContent = on ? '☀️' : '🌙';
}

function go(v, el) {
    document.querySelectorAll('.view').forEach(x => x.classList.remove('act'));
    document.querySelectorAll('.ntab').forEach(x => x.classList.remove('act'));
    
    document.getElementById('v-' + v).classList.add('act');
    el.classList.add('act');

    if (v === 'overview') renderDashboard();
    if (v === 'subjects') renderSubjects();
    if (v === 'history') renderHistory();
    if (v === 'insights') renderInsights();
    if (v === 'settings') renderSettingsPage();
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
    t.textContent = m;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3000);
}
