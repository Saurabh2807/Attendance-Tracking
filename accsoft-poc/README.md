# Accsoft Login Proof of Concept (POC)

This is a local Node.js proof-of-concept to verify programmatic login and session maintenance on LNCT's Accsoft portal, retrieve the student's attendance page HTML, and verify that the content contains actual attendance data.

## Setup Instructions

1. **Navigate to the POC directory:**
   ```bash
   cd accsoft-poc
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure environment variables:**
   - Copy the `.env.example` file to `.env`:
     ```bash
     cp .env.example .env
     ```
   - Open `.env` and fill in your Accsoft student login credentials:
     ```env
     ENROLLMENT=YOUR_ENROLLMENT_NUMBER
     PASSWORD=YOUR_PASSWORD
     ```

4. **Run the script:**
   ```bash
   npm start
   ```

## Expected Results
- Prints the names of all dynamically found hidden fields.
- Submits the login POST request.
- Outputs diagnostic post-login state (Final URL, Page Title, Cookie Count, Status Code).
- Saves `login-response.html` and `attendance.html` in the root.
- Runs diagnostic validation checking for keywords like "Subject Name", "Present Count", "Attendance Status" and counts tables found.
- Prints confirmation of success or a detailed error trace.
