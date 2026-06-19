const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');

// Load environment variables
require('dotenv').config();

const ENROLLMENT = process.env.ENROLLMENT;
const PASSWORD = process.env.PASSWORD;

if (!ENROLLMENT || !PASSWORD) {
    console.error("LOGIN FAILED: Credentials missing in .env file. Please check ENROLLMENT and PASSWORD variables.");
    process.exit(1);
}

// URLs
const LOGIN_URL = 'https://portal.lnct.ac.in/Accsoft2/studentlogin.aspx';
const ATTENDANCE_URL = 'https://portal.lnct.ac.in/Accsoft2/Parents/StuAttendanceStatus.aspx';

async function run() {
    console.log("==================================================");
    console.log("Accsoft Login Proof of Concept Execution Started");
    console.log("==================================================");

    // Initialize Axios with Cookie Jar Support
    const jar = new CookieJar();
    const client = wrapper(axios.create({
        jar,
        withCredentials: true,
        maxRedirects: 5,
        timeout: 15000, // 15 seconds timeout
        headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9'
        }
    }));

    // Step 1: Request studentlogin.aspx to extract ASP.NET hidden and default fields
    console.log("\nStep 1: Fetching studentlogin.aspx to parse form inputs dynamically...");
    let getResponse;
    try {
        getResponse = await client.get(LOGIN_URL);
    } catch (error) {
        console.error(`\nLOGIN FAILED: Network timeout or login page unavailable.`);
        console.error(`Detail: ${error.message}`);
        process.exit(1);
    }

    const $ = cheerio.load(getResponse.data);
    const payload = new URLSearchParams();
    const parsedFields = [];

    // Dynamically parse all input elements in the form
    $('input').each((i, elem) => {
        const name = $(elem).attr('name');
        const type = $(elem).attr('type') || 'text';
        const value = $(elem).attr('value') || '';

        if (!name) return;

        // Skip the text inputs that we will manually fill with credentials
        if (name === 'ctl00$cph1$txtStuUser' || name === 'ctl00$cph1$txtStuPsw') {
            return;
        }

        // Only include checkboxes/radio buttons if checked
        if (type === 'radio' || type === 'checkbox') {
            const isChecked = $(elem).attr('checked') !== undefined;
            if (isChecked) {
                payload.append(name, value);
                parsedFields.push({ name, value, type });
            }
        } 
        // Handle all hidden, submit, and other button inputs
        else if (type === 'hidden' || type === 'submit' || type === 'button') {
            payload.append(name, value);
            parsedFields.push({ name, value, type });
        }
    });

    // Dynamically parse all select elements and get selected option
    $('select').each((i, elem) => {
        const name = $(elem).attr('name');
        if (!name) return;
        
        const selectedOption = $(elem).find('option[selected]');
        const val = selectedOption.attr('value') || $(elem).find('option').first().attr('value') || '';
        payload.append(name, val);
        parsedFields.push({ name, value: val, type: 'select' });
    });

    console.log("\nDynamically Extracted Form Fields:");
    parsedFields.forEach(f => {
        console.log(`- [${f.type}] ${f.name} = "${f.value}"`);
    });

    if (parsedFields.length === 0) {
        console.error("\nLOGIN FAILED: Hidden fields not found");
        process.exit(1);
    }

    // Append our user credentials to the payload
    payload.append('ctl00$cph1$txtStuUser', ENROLLMENT);
    payload.append('ctl00$cph1$txtStuPsw', PASSWORD);

    // Step 2: Submit login POST request
    console.log("\nStep 2: Submitting login...");
    let postResponse;
    try {
        postResponse = await client.post(LOGIN_URL, payload, {
            headers: {
                'Referer': LOGIN_URL,
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });
    } catch (error) {
        if (error.code === 'ERR_TOO_MANY_REDIRECTS' || error.message.includes('redirect')) {
            console.error("\nLOGIN FAILED: Unexpected redirect or redirect loop");
        } else {
            console.error("\nLOGIN FAILED: Network timeout or connection error during login submission");
        }
        console.error(`Detail: ${error.message}`);
        process.exit(1);
    }

    // Save login response for debugging
    try {
        fs.writeFileSync('login-response.html', postResponse.data, 'utf8');
        console.log("Saved login-response.html successfully.");
    } catch (err) {
        console.error("Warning: Could not save login-response.html:", err.message);
    }

    // Step 3: Parse and print post-login diagnostics
    const postDoc = cheerio.load(postResponse.data);
    const pageTitle = postDoc('title').text().trim() || 'No Title';
    const finalUrl = postResponse.request.res.responseUrl || postResponse.config.url;
    const cookies = await jar.getCookies(LOGIN_URL);
    const cookieCount = cookies.length;

    console.log("\nPost-Login Details:");
    console.log(`- Final URL: ${finalUrl}`);
    console.log(`- Page Title: ${pageTitle}`);
    console.log(`- Cookie Count: ${cookieCount}`);
    console.log(`- Status Code: ${postResponse.status}`);

    const isLoginPage = finalUrl.toLowerCase().includes('studentlogin.aspx');
    const hasErrorMessage = postResponse.data.includes('Invalid User Name or Password') || 
                            postResponse.data.includes('Incorrect password') ||
                            postResponse.data.includes('Try Again');

    if (isLoginPage || hasErrorMessage) {
        console.error("\nLOGIN FAILED: Invalid credentials");
        process.exit(1);
    }

    console.log("\nLOGIN SUCCESS");

    // Step 4: Access attendance page using authenticated session
    console.log("\nStep 4: Fetching attendance page...");
    let attResponse;
    try {
        attResponse = await client.get(ATTENDANCE_URL);
    } catch (error) {
        console.error("\nLOGIN FAILED: Attendance page unavailable");
        console.error(`Detail: ${error.message}`);
        process.exit(1);
    }

    // Step 5: Save attendance page HTML
    try {
        fs.writeFileSync('attendance.html', attResponse.data, 'utf8');
        console.log("attendance.html saved successfully");
    } catch (err) {
        console.error("\nLOGIN FAILED: Could not save attendance.html");
        console.error(`Detail: ${err.message}`);
        process.exit(1);
    }

    // Verify session expiration / redirect back to login
    const attFinalUrl = attResponse.request.res.responseUrl || attResponse.config.url;
    if (attFinalUrl.toLowerCase().includes('studentlogin.aspx')) {
        console.error("\nLOGIN FAILED: Session expiration");
        process.exit(1);
    }

    // Step 6: Diagnostics & Verification
    console.log("\nStep 6: Running diagnostic checks on attendance.html...");
    const attDoc = cheerio.load(attResponse.data);
    const tableCount = attDoc('table').length;
    
    // Extract first 300 characters of tables text
    const allTablesText = attDoc('table').text().replace(/\s+/g, ' ').trim();
    const tableSnippet = allTablesText.substring(0, 300);

    // Look for attendance keywords (case-insensitive)
    const hasSubjectName = /subject\s*name/i.test(attResponse.data);
    const hasPresentCount = /present\s*count/i.test(attResponse.data);
    const hasAttendanceStatus = /attendance\s*status/i.test(attResponse.data);

    // Dynamic keyword groups for summary/log identification
    const hasSummaryKeywords = /subject|present|absent|percentage|held|attended/i.test(attResponse.data);
    const hasLogKeywords = /date|status|present|absent|period|lecture/i.test(attResponse.data);

    console.log("\nDiagnostics:");
    console.log(`- Total tables found: ${tableCount}`);
    console.log(`- First 300 characters of table text: "${tableSnippet}"`);
    console.log(`- Summary table keywords detected (subject/present/percentage/etc.): ${hasSummaryKeywords ? 'YES' : 'NO'}`);
    console.log(`- Attendance log keywords detected (date/status/lecture/etc.): ${hasLogKeywords ? 'YES' : 'NO'}`);
    console.log(`- Keyword 'Subject Name' found: ${hasSubjectName ? 'YES' : 'NO'}`);
    console.log(`- Keyword 'Present Count' found: ${hasPresentCount ? 'YES' : 'NO'}`);
    console.log(`- Keyword 'Attendance Status' found: ${hasAttendanceStatus ? 'YES' : 'NO'}`);

    const responseSizeKB = Math.round(attResponse.data.length / 1024);
    const finalCookies = await jar.getCookies(ATTENDANCE_URL);

    // Step 7: Evaluate Success Criteria
    console.log("\n========================================");
    if (tableCount > 1 && (hasSubjectName || hasPresentCount || hasAttendanceStatus || (hasSummaryKeywords && hasLogKeywords))) {
        console.log("LOGIN SUCCESS\n");
        console.log(`Status Code: ${attResponse.status}\n`);
        console.log(`Final URL:\n${attFinalUrl}\n`);
        console.log(`Response Size:\n${responseSizeKB} KB\n`);
        console.log(`Cookies:\n${finalCookies.length}\n`);
        console.log(`Tables Found:\n${tableCount}\n`);
        console.log("ATTENDANCE PAGE RETRIEVED SUCCESSFULLY");
    } else {
        console.error("LOGIN FAILED: Attendance page structure invalid or keywords missing");
        process.exit(1);
    }
    console.log("========================================");
}

run();
