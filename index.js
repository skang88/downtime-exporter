const express = require('express');
const mysql = require('mysql2/promise'); // MySQL 모듈 유지
const sql = require('mssql'); // mssql 모듈 추가
const promClient = require('prom-client');
const moment = require('moment-timezone');

// --- Configuration ---
// 환경 변수를 통해 데이터베이스 연결 정보를 설정하는 것이 좋습니다.

const dbConfig = { // MySQL DB 설정
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE, 
    dateStrings: true // DATETIME 값을 문자열로 가져오도록 설정
};

const mssqlConfig = { // MS SQL DB 설정
    user: process.env.MSSQL_USER,
    password: process.env.MSSQL_PASSWORD,
    server: process.env.MSSQL_HOST, 
    database: process.env.MSSQL_DATABASE,
    options: {
        encrypt: false, 
        trustServerCertificate: true 
    }
};


const port = process.env.PORT || 8002;
const tablesToMonitor = ['F01', 'R01'];

// --- Prometheus Metrics ---
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

// Metric 1: 현재 진행중인 다운타임 (마지막 생산시간 ~ 현재시간)
const ongoingDowntimeGauge = new promClient.Gauge({
    name: 'production_ongoing_downtime_seconds',
    help: 'Ongoing downtime since the last production event for a specific line.',
    labelNames: ['line', 'model'],
    registers: [register]
});




// --- Application Logic ---
const app = express();
// 각 테이블의 마지막으로 확인된 타임스탬프와 사이클 타임을 저장합니다.
let lastKnownTimestamps = {};

/**
 * 주기적으로 다운타임을 확인하고 메트릭을 업데이트합니다.
 */
async function checkDowntime() {
    let mysqlConnection;
    let mssqlConnection;
    try {
        mysqlConnection = await mysql.createConnection(dbConfig);
        mssqlConnection = await sql.connect(mssqlConfig); // Establish MS SQL connection

        const nowForShift = moment().tz('America/New_York');
        const todayShiftStart = nowForShift.clone().startOf('day').add(7, 'hours');

        for (const table of tablesToMonitor) {
            // --- Fetch Production Plan and Actual Production from MS SQL ---
            const productionPlanQuery = `
                SELECT ISNULL(SUM(PL_QTY), 0) AS TotalPlan, ISNULL(SUM(RH_QTY), 0) AS TotalWorked
                FROM SAG.dbo.PRD_PRDPDPF
                WHERE RDATE = CONVERT(CHAR(8), GETDATE(), 112)
                  AND LTRIM(RTRIM(WRK_CD)) = @lineCode;
            `;
            const request = mssqlConnection.request();
            request.input('lineCode', sql.NVarChar, table); // Parameterize lineCode
            const result = await request.query(productionPlanQuery);
            const { TotalPlan, TotalWorked } = result.recordset[0];

            // --- Conditional Downtime Calculation based on Production Plan ---
            if (TotalPlan === 0 || TotalWorked >= TotalPlan) {
                console.log(`[${new Date().toISOString()}] Line ${table}: Production plan is 0 or actual production (${TotalWorked}) meets/exceeds plan (${TotalPlan}). Setting downtime to 0.`);
                ongoingDowntimeGauge.labels(table, 'no_production_or_plan_met').set(0);
                cycleTimeGauge.labels(table, 'no_production_or_plan_met').set(0); // Also reset cycle time if no production/plan met
                lastKnownTimestamps[table] = undefined; // Reset last known timestamp
                continue; // Skip further downtime calculation for this table
            }

            // --- Daily Reset Logic ---
            // If the last known timestamp is from before the start of today's shift, reset it.
            if (lastKnownTimestamps[table] && moment(lastKnownTimestamps[table]).isBefore(todayShiftStart)) {
                console.log(`[${new Date().toISOString()}] New shift detected for table ${table}. Resetting last known timestamp.`);
                lastKnownTimestamps[table] = undefined;
            }

            let downtimeToLog = 0;
            let lastProdTimeToLog = 'N/A';

            // --- Initialization Logic (runs only if lastKnownTimestamps[table] is not set) ---
            if (!lastKnownTimestamps[table]) {
                const initSql = `SELECT 
                                timestamp, model 
                                FROM SPC.${table} 
                                WHERE timestamp >= ? 
                                ORDER BY timestamp DESC LIMIT 2`;
                const [initRows] = await mysqlConnection.execute(initSql, [todayShiftStart.format('YYYY-MM-DD HH:mm:ss')]);

                if (initRows.length > 0) {
                    initRows.reverse(); 
                    const lastProdEvent = initRows[initRows.length - 1];
                    const lastTs = moment.tz(lastProdEvent.timestamp, 'America/New_York').toDate();
                    const lastModel = lastProdEvent.model || 'unknown'; // Default to 'unknown' if model is null

                    if (initRows.length === 2) {
                        const secondLastProdEvent = initRows[0];
                        const secondLastTs = moment.tz(secondLastProdEvent.timestamp, 'America/New_York').toDate();
                        const cycleTimeSeconds = (lastTs.getTime() - secondLastTs.getTime()) / 1000;

                        // Cycle time metric removed
                    }
                    lastKnownTimestamps[table] = { timestamp: lastTs, model: lastModel }; 
                } else {
                    // No production data found for today's shift yet.
                    // Downtime will be reported as 0 until the first event is detected.
                    lastKnownTimestamps[table] = undefined;
                }
            }

            // --- Main processing logic for new items (Cycle Time) ---
            const lastKnownProdEvent = lastKnownTimestamps[table];
            if (lastKnownProdEvent) {
                const sql = `SELECT 
                            timestamp, model 
                            FROM SPC.${table} WHERE 
                            timestamp 
                            > ? ORDER BY 
                            timestamp 
                            ASC`;
                const [newRows] = await mysqlConnection.execute(sql, [moment().tz(lastKnownProdEvent.timestamp, 'America/New_York').format('YYYY-MM-DD HH:mm:ss')]);
                
                if (newRows.length > 0) {
                    let previousTimestampInBatch = lastKnownProdEvent.timestamp;
                    let previousModelInBatch = lastKnownProdEvent.model;

                    for (const currentProdEvent of newRows) {
                        const currentTimestamp = moment.tz(currentProdEvent.timestamp, 'America/New_York').toDate();
                        const currentModel = currentProdEvent.model || 'unknown';

                        const cycleTimeSeconds = (currentTimestamp.getTime() - previousTimestampInBatch.getTime()) / 1000;
                        // Cycle time metric removed
                        previousTimestampInBatch = currentTimestamp;
                        previousModelInBatch = currentModel;
                    }
                    lastKnownTimestamps[table] = { timestamp: previousTimestampInBatch, model: previousModelInBatch };
                }
            }

            // --- Ongoing downtime calculation ---
            const now = moment().tz('America/New_York');
            const currentHour = now.hours();
            const currentMinute = now.minutes();

            const isWorkingHours =
                (currentHour > 7 || (currentHour === 7 && currentMinute >= 0)) &&
                (currentHour < 15 || (currentHour === 15 && currentMinute <= 30));

            if (lastKnownTimestamps[table]) {
                const lastProdEvent = lastKnownTimestamps[table];
                const lastProductionTime = moment.tz(lastProdEvent.timestamp, 'America/New_York');
                const lastModel = lastProdEvent.model;

                lastProdTimeToLog = lastProductionTime.format('YYYY-MM-DD HH:mm:ss');
                console.log(`[DEBUG] Line ${table}: isWorkingHours=${isWorkingHours}, lastProductionTime=${lastProductionTime.format()}, lastModel=${lastModel}`);
                if (isWorkingHours) {
                    const downtimeSeconds = now.diff(lastProductionTime, 'seconds');
                    downtimeToLog = downtimeSeconds > 0 ? downtimeSeconds : 0;
                    console.log(`[DEBUG] Line ${table}: downtimeSeconds=${downtimeSeconds}, downtimeToLog=${downtimeToLog}`);
                    ongoingDowntimeGauge.labels(table, lastModel).set(downtimeToLog);
                } else {
                    downtimeToLog = 0;
                    console.log(`[DEBUG] Line ${table}: Not working hours, downtimeToLog=${downtimeToLog}`);
                    ongoingDowntimeGauge.labels(table, lastModel).set(downtimeToLog);
                }
            } else {
                // If no lastKnownTimestamps, set downtime to 0 with a default model label
                downtimeToLog = 0;
                console.log(`[DEBUG] Line ${table}: No lastKnownTimestamps, downtimeToLog=${downtimeToLog}`);
                ongoingDowntimeGauge.labels(table, 'no_production').set(downtimeToLog);
            }

            // --- Final Logging for this table ---
            const currentTime = now.format('HH:mm');
            console.log(
                `[${new Date().toISOString()}] Current Time: ${currentTime}, Is Working Hours: ${isWorkingHours}, ` +
                `Last Time ${table}: ${lastProdTimeToLog}, ` +
                `downtime "${table}"} ${downtimeToLog}, ` +
                `Plan: ${TotalPlan}, Worked: ${TotalWorked}`
            );
        }

    } catch (error) {
        console.error('Database connection failed:', error.message);
    } finally {
        if (mysqlConnection) {
            await mysqlConnection.end();
        }
        if (mssqlConnection) {
            await mssqlConnection.close();
        }
    }
}

// --- Server Setup ---
app.get('/metrics', async (req, res) => {
    try {
        res.set('Content-Type', register.contentType);
        res.end(await register.metrics());
    } catch (ex) {
        res.status(500).end(ex);
    }
});

app.listen(port, () => {
    const pollingInterval = parseInt(process.env.POLLING_INTERVAL_MS || '10000', 10);
    console.log(`Downtime Exporter listening at http://localhost:${port}`);
    console.log(`Polling database every ${pollingInterval / 1000} seconds.`);
    // 주기적으로 다운타임 확인 시작
    setInterval(checkDowntime, pollingInterval);
    // 초기 실행
    checkDowntime();
});