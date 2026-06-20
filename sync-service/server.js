const fs = require('fs');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');
const { createClient } = require('@supabase/supabase-js');

// Load environment variables
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Verify Supabase configs
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error("Error: SUPABASE_URL or SUPABASE_ANON_KEY is not defined in environment.");
    process.exit(1);
}

// Generate or read Encryption Key
let ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY) {
    console.warn("WARNING: ENCRYPTION_KEY environment variable is not set. Generating a temporary 32-byte key for this session.");
    ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
} else if (ENCRYPTION_KEY.length !== 64) {
    console.error("Error: ENCRYPTION_KEY must be a 64-character hex string (32 bytes).");
    process.exit(1);
}

// AES-256-GCM Helper functions
const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

function encryptPassword(password) {
    const key = Buffer.from(ENCRYPTION_KEY, 'hex');
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    let encrypted = cipher.update(password, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const authTag = cipher.getAuthTag().toString('hex');
    
    return {
        encrypted_password: encrypted,
        iv: iv.toString('hex'),
        auth_tag: authTag
    };
}

function decryptPassword(encrypted, ivHex, tagHex) {
    const key = Buffer.from(ENCRYPTION_KEY, 'hex');
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
}

// Month names mappings
const monthMap = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    january: '01', february: '02', march: '03', april: '04', june: '06',
    july: '07', august: '08', september: '09', october: '10', november: '11', december: '12'
};

function normalizeDate(dateStr) {
    if (!dateStr) return '';
    const cleaned = dateStr.trim().replace(/\s+/g, ' ');
    const parts = cleaned.split(' ');
    if (parts.length === 3) {
        const day = parts[0].padStart(2, '0');
        const monthWord = parts[1].toLowerCase();
        const year = parts[2];
        const monthNum = monthMap[monthWord];
        if (monthNum) {
            return `${year}-${monthNum}-${day}`;
        }
    }
    const slashParts = cleaned.split('/');
    if (slashParts.length === 3) {
        const day = slashParts[0].padStart(2, '0');
        const month = slashParts[1].padStart(2, '0');
        const year = slashParts[2];
        return `${year}-${month}-${day}`;
    }
    return cleaned;
}

// Scraper function
const LOGIN_URL = 'https://portal.lnct.ac.in/Accsoft2/studentlogin.aspx';
const ATTENDANCE_URL = 'https://portal.lnct.ac.in/Accsoft2/Parents/StuAttendanceStatus.aspx';

async function scrapeAccsoft(enrollment, password) {
    const jar = new CookieJar();
    const client = wrapper(axios.create({
        jar,
        withCredentials: true,
        maxRedirects: 5,
        timeout: 20000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9'
        }
    }));

    // Step 1: Fetch Login Page and parse hidden/defaults
    let getResponse;
    try {
        getResponse = await client.get(LOGIN_URL);
    } catch (err) {
        throw new Error('ACC_SOFT_UNAVAILABLE');
    }

    const $ = cheerio.load(getResponse.data);
    const payload = new URLSearchParams();
    let hiddenCount = 0;

    // Dynamically parse inputs
    $('input').each((i, elem) => {
        const name = $(elem).attr('name');
        const type = $(elem).attr('type') || 'text';
        const value = $(elem).attr('value') || '';

        if (!name) return;
        if (name === 'ctl00$cph1$txtStuUser' || name === 'ctl00$cph1$txtStuPsw') return;

        if (type === 'radio' || type === 'checkbox') {
            if ($(elem).attr('checked') !== undefined) {
                payload.append(name, value);
                hiddenCount++;
            }
        } else if (type === 'hidden' || type === 'submit' || type === 'button') {
            payload.append(name, value);
            hiddenCount++;
        }
    });

    // Parse select elements
    $('select').each((i, elem) => {
        const name = $(elem).attr('name');
        if (!name) return;
        const selected = $(elem).find('option[selected]');
        const val = selected.attr('value') || $(elem).find('option').first().attr('value') || '';
        payload.append(name, val);
    });

    if (hiddenCount === 0) {
        throw new Error('LOGIN_FAILED');
    }

    payload.append('ctl00$cph1$txtStuUser', enrollment);
    payload.append('ctl00$cph1$txtStuPsw', password);

    // Step 2: Login Post submission
    let postResponse;
    try {
        postResponse = await client.post(LOGIN_URL, payload, {
            headers: {
                'Referer': LOGIN_URL,
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });
    } catch (err) {
        throw new Error('LOGIN_FAILED');
    }

    const finalUrl = postResponse.request.res.responseUrl || postResponse.config.url;
    const isLoginPage = finalUrl.toLowerCase().includes('studentlogin.aspx');
    const hasErrorMessage = postResponse.data.includes('Invalid User Name or Password') || 
                            postResponse.data.includes('Incorrect password') ||
                            postResponse.data.includes('Try Again');

    if (isLoginPage || hasErrorMessage) {
        throw new Error('INVALID_CREDENTIALS');
    }

    // Step 3: Fetch Attendance status page
    let attResponse;
    try {
        attResponse = await client.get(ATTENDANCE_URL);
    } catch (err) {
        throw new Error('LOGIN_FAILED');
    }

    const attFinalUrl = attResponse.request.res.responseUrl || attResponse.config.url;
    if (attFinalUrl.toLowerCase().includes('studentlogin.aspx')) {
        throw new Error('LOGIN_FAILED');
    }

    // Step 4: Parse attendance html
    const attDoc = cheerio.load(attResponse.data);
    let summaryData = [];
    let logsData = [];

    attDoc('table').each((tableIdx, table) => {
        const rows = attDoc(table).find('tr');
        if (rows.length === 0) return;

        let headerRow = null;
        let colMap = {};
        let headerIdx = -1;

        for (let r = 0; r < Math.min(3, rows.length); r++) {
            const cells = attDoc(rows[r]).find('th, td').map((c, el) => attDoc(el).text().replace(/\s+/g, ' ').trim().toLowerCase()).get();
            
            if (cells.includes('subject name') && (cells.includes('total class held') || cells.includes('class held'))) {
                headerRow = cells;
                headerIdx = r;
                colMap = {
                    subject: cells.indexOf('subject name'),
                    held: cells.indexOf('total class held') !== -1 ? cells.indexOf('total class held') : cells.indexOf('class held'),
                    present: cells.indexOf('present count') !== -1 ? cells.indexOf('present count') : cells.indexOf('net present'),
                    absent: cells.indexOf('absent count')
                };
                break;
            }

            if (cells.includes('date') && cells.includes('subject') && cells.includes('attendance status')) {
                headerRow = cells;
                headerIdx = r;
                colMap = {
                    date: cells.indexOf('date'),
                    period: cells.indexOf('period no.') !== -1 ? cells.indexOf('period no.') : cells.indexOf('period'),
                    subject: cells.indexOf('subject'),
                    status: cells.indexOf('attendance status')
                };
                break;
            }
        }

        if (!headerRow) return;

        for (let r = headerIdx + 1; r < rows.length; r++) {
            const cells = attDoc(rows[r]).find('td').map((c, el) => attDoc(el).text().replace(/\s+/g, ' ').trim()).get();
            if (cells.length === 0) continue;

            if (colMap.held !== undefined && colMap.subject !== undefined) {
                const subject = cells[colMap.subject];
                if (!subject || subject.toLowerCase() === 'total' || subject.toLowerCase() === 'grand total') continue;

                const held = parseInt(cells[colMap.held]) || 0;
                const present = parseInt(cells[colMap.present]) || 0;
                const absent = parseInt(cells[colMap.absent]) || 0;
                const percentage = held > 0 ? parseFloat(((present / held) * 100).toFixed(2)) : 0.0;

                summaryData.push({
                    subject_name: subject,
                    held,
                    present,
                    absent,
                    percentage
                });
            } else if (colMap.date !== undefined && colMap.subject !== undefined) {
                const rawDate = cells[colMap.date];
                const subject = cells[colMap.subject];
                if (!rawDate || !subject) continue;

                const date = normalizeDate(rawDate);
                const period = parseInt(cells[colMap.period]) || 0;
                const status = cells[colMap.status] || '';

                logsData.push({
                    date,
                    period,
                    subject,
                    status
                });
            }
        }
    });

    if (summaryData.length === 0 && logsData.length === 0) {
        throw new Error('PARSING_FAILED');
    }

    return { summaryData, logsData };
}

// Middleware to verify authorization token
async function verifyUserToken(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authorization token missing' });
    }

    // Initialize Supabase Client dynamically with incoming user's token
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: {
            headers: {
                Authorization: authHeader
            }
        }
    });

    try {
        const { data: { user }, error } = await supabase.auth.getUser();
        if (error || !user) {
            return res.status(401).json({ error: 'Invalid authentication credentials' });
        }
        // Save authenticated user and client to request
        req.user = user;
        req.supabase = supabase;
        next();
    } catch (err) {
        return res.status(500).json({ error: 'Auth service verification failed' });
    }
}

// API Routes
app.post('/connect-accsoft', verifyUserToken, async (req, res) => {
    const { enrollment_no, password } = req.body;
    if (!enrollment_no || !password) {
        return res.status(400).json({ error: 'Enrollment number and password are required' });
    }

    console.log(`Connecting Accsoft for user: ${req.user.id}, Enrollment: ${enrollment_no}`);

    try {
        // Step 1: Verify credentials by logging in once
        await scrapeAccsoft(enrollment_no, password);
        
        // Step 2: Encrypt password
        const enc = encryptPassword(password);

        // Step 3: Save to Supabase
        const { error } = await req.supabase
            .from('accsoft_connections')
            .upsert({
                user_id: req.user.id,
                enrollment_no: enrollment_no,
                encrypted_password: enc.encrypted_password,
                iv: enc.iv,
                auth_tag: enc.auth_tag,
                last_sync_at: new Date().toISOString(),
                last_sync_status: 'SUCCESS',
                last_sync_message: 'Successfully connected and verified account.'
            }, { onConflict: 'user_id' });

        if (error) {
            console.error("Database upsert failed:", error);
            return res.status(500).json({ error: 'Failed to save connection details' });
        }

        res.json({ success: true, message: 'Account connected successfully' });
    } catch (err) {
        const errMsg = err.message || 'LOGIN_FAILED';
        console.error(`Accsoft connection failed for ${enrollment_no}: ${errMsg}`);

        // Update database if connection record already exists
        await req.supabase
            .from('accsoft_connections')
            .upsert({
                user_id: req.user.id,
                enrollment_no: enrollment_no,
                // Don't modify encrypted details, just status
                last_sync_at: new Date().toISOString(),
                last_sync_status: errMsg,
                last_sync_message: `Verification failed: ${errMsg}`
            }, { onConflict: 'user_id' });

        const statusMap = {
            'INVALID_CREDENTIALS': 401,
            'ACC_SOFT_UNAVAILABLE': 503,
            'PARSING_FAILED': 422
        };
        const status = statusMap[errMsg] || 400;
        res.status(status).json({ error: `Connection failed: ${errMsg}` });
    }
});

app.post('/sync-attendance', verifyUserToken, async (req, res) => {
    console.log(`Starting attendance sync for user: ${req.user.id}`);

    try {
        // Step 1: Fetch connection details
        const { data: conn, error: connErr } = await req.supabase
            .from('accsoft_connections')
            .select('*')
            .eq('user_id', req.user.id)
            .single();

        if (connErr || !conn) {
            return res.status(404).json({ error: 'No Accsoft connection found. Please connect your account first.' });
        }

        // Step 2: Decrypt password
        let password;
        try {
            password = decryptPassword(conn.encrypted_password, conn.iv, conn.auth_tag);
        } catch (decErr) {
            console.error("Password decryption failed:", decErr);
            throw new Error('DECRYPTION_FAILED');
        }

        // Step 3: Run Scraper
        const { summaryData, logsData } = await scrapeAccsoft(conn.enrollment_no, password);

        // Step 4: Write summaries
        const summariesToInsert = summaryData.map(s => ({
            user_id: req.user.id,
            subject_name: s.subject_name,
            held: s.held,
            present: s.present,
            absent: s.absent,
            percentage: s.percentage,
            synced_at: new Date().toISOString()
        }));

        if (summariesToInsert.length > 0) {
            const { error: sumErr } = await req.supabase
                .from('attendance_summary')
                .upsert(summariesToInsert, { onConflict: 'user_id,subject_name' });
            if (sumErr) throw sumErr;
        }

        // Step 5: Write datewise logs
        const logsToInsert = logsData.map(l => ({
            user_id: req.user.id,
            attendance_date: l.date,
            period_no: l.period,
            subject_name: l.subject,
            status: l.status,
            synced_at: new Date().toISOString()
        }));

        if (logsToInsert.length > 0) {
            const { error: logsErr } = await req.supabase
                .from('attendance_logs')
                .upsert(logsToInsert, { onConflict: 'user_id,attendance_date,period_no,subject_name' });
            if (logsErr) throw logsErr;
        }

        // Step 6: Log SUCCESS state
        await req.supabase
            .from('accsoft_connections')
            .update({
                last_sync_at: new Date().toISOString(),
                last_sync_status: 'SUCCESS',
                last_sync_message: `Synced successfully: ${summariesToInsert.length} subjects, ${logsToInsert.length} periods.`
            })
            .eq('user_id', req.user.id);

        res.json({
            success: true,
            summaryCount: summariesToInsert.length,
            logCount: logsToInsert.length,
            message: 'Attendance data synced successfully'
        });

    } catch (err) {
        const errMsg = err.message || 'LOGIN_FAILED';
        console.error(`Attendance sync failed for ${req.user.id}: ${errMsg}`);

        // Update database with sync error status
        await req.supabase
            .from('accsoft_connections')
            .update({
                last_sync_at: new Date().toISOString(),
                last_sync_status: errMsg,
                last_sync_message: `Sync failed: ${errMsg}`
            })
            .eq('user_id', req.user.id)
            .select(); // execute update

        const statusMap = {
            'INVALID_CREDENTIALS': 401,
            'ACC_SOFT_UNAVAILABLE': 503,
            'PARSING_FAILED': 422,
            'DECRYPTION_FAILED': 500
        };
        const status = statusMap[errMsg] || 400;
        res.status(status).json({ error: `Sync failed: ${errMsg}` });
    }
});

// Debugging & Health Check Routes
app.get('/', (req, res) => {
    res.json({
        message: 'AttendEase Sync Service is running.',
        endpoints: {
            health: 'GET /health',
            connectAccsoft: 'POST /connect-accsoft',
            syncAttendance: 'POST /sync-attendance'
        }
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString()
    });
});

// Start Express Server
app.listen(PORT, () => {
    console.log(`AttendEase Sync Service running on port ${PORT}`);
});

