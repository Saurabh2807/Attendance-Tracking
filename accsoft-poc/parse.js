const fs = require('fs');
const cheerio = require('cheerio');

const monthMap = {
    jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
    jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    january: '01', february: '02', march: '03', april: '04', june: '06',
    july: '07', august: '08', september: '09', october: '10', november: '11', december: '12'
};

function normalizeDate(dateStr) {
    if (!dateStr) return '';
    const cleaned = dateStr.trim().replace(/\s+/g, ' ');
    
    // Handle format "16 Mar 2026"
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
    
    // Handle format "16/03/2026"
    const slashParts = cleaned.split('/');
    if (slashParts.length === 3) {
        const day = slashParts[0].padStart(2, '0');
        const month = slashParts[1].padStart(2, '0');
        const year = slashParts[2];
        return `${year}-${month}-${day}`;
    }
    
    return cleaned;
}

function parseHTML() {
    console.log("=========================================");
    console.log("Accsoft Attendance HTML Parser Prototype");
    console.log("=========================================");

    const htmlPath = 'attendance.html';
    if (!fs.existsSync(htmlPath)) {
        console.error(`Error: ${htmlPath} not found. Please run the login POC first.`);
        process.exit(1);
    }

    const html = fs.readFileSync(htmlPath, 'utf8');
    const $ = cheerio.load(html);

    let summaryData = [];
    let logsData = [];

    // Find all table elements
    $('table').each((tableIdx, table) => {
        const rows = $(table).find('tr');
        if (rows.length === 0) return;

        // Try to identify header row by scanning first 3 rows
        let headerRow = null;
        let colMap = {};
        let headerIdx = -1;

        for (let r = 0; r < Math.min(3, rows.length); r++) {
            const cells = $(rows[r]).find('th, td').map((c, el) => $(el).text().replace(/\s+/g, ' ').trim().toLowerCase()).get();
            
            // Check if this row is a summary header
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

            // Check if this row is a logs header
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

        if (!headerRow) return; // Not an attendance table

        // Parse subsequent rows
        for (let r = headerIdx + 1; r < rows.length; r++) {
            const cells = $(rows[r]).find('td').map((c, el) => $(el).text().replace(/\s+/g, ' ').trim()).get();
            
            // Safe missing cell handling
            if (cells.length === 0) continue;

            // Summary table parsing
            if (colMap.held !== undefined && colMap.subject !== undefined) {
                const subject = cells[colMap.subject];
                // Ignore empty or summary totals row
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
            }
            // Logs table parsing
            else if (colMap.date !== undefined && colMap.subject !== undefined) {
                const rawDate = cells[colMap.date];
                const subject = cells[colMap.subject];
                if (!rawDate || !subject) continue; // skip incomplete rows safely

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

    // Save outputs
    fs.writeFileSync('attendance-summary.json', JSON.stringify(summaryData, null, 2), 'utf8');
    fs.writeFileSync('attendance-logs.json', JSON.stringify(logsData, null, 2), 'utf8');

    console.log("\nParsing Summary:");
    console.log(`- Summary records extracted: ${summaryData.length}`);
    console.log(`- Attendance log records extracted: ${logsData.length}`);
    console.log("\nFiles saved successfully:");
    console.log("- attendance-summary.json");
    console.log("- attendance-logs.json");
    console.log("=========================================");
}

parseHTML();
