require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise'); // MySQL 모듈 유지
const sql = require('mssql'); // mssql 모듈 추가
const promClient = require('prom-client');
const moment = require('moment-timezone');

// --- Configuration ---
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
    port: Number(process.env.MSSQL_PORT) || 1433, // 포트 설정 추가
    options: {
        encrypt: false, 
        trustServerCertificate: true 
    }
};

const port = process.env.PORT || 8002;
const tablesToMonitor = ['F01', 'R01', 'C01'];


// --- Prometheus Metrics ---
const register = new promClient.Registry();
promClient.collectDefaultMetrics({ register });

// Metric 1: 현재 진행중인 다운타임 (마지막 생산시간 ~ 현재시간)
const ongoingDowntimeGauge = new promClient.Gauge({
    name: 'production_ongoing_downtime_seconds',
    help: 'Ongoing downtime since the last production event for a specific line.',
    labelNames: ['line', 'model', 'status'],
    registers: [register]
});


// --- Application Logic ---
const app = express();
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
            if (TotalPlan === 0) {
                if (lastKnownTimestamps[table] && lastKnownTimestamps[table].model) {
                    const lastModel = lastKnownTimestamps[table].model;
                    ongoingDowntimeGauge.labels(table, lastModel, 'working_hours').set(0);
                    console.log(`[${new Date().toISOString()}] Line ${table}: Resetting downtime for model ${lastModel} because there is no production plan.`);
                }

                console.log(`[${new Date().toISOString()}] Line ${table}: Production plan is 0. Setting downtime to 0.`);
                ongoingDowntimeGauge.remove(table, '', 'production_complete');
                ongoingDowntimeGauge.remove(table, '', 'no_production_data');
                lastKnownTimestamps[table] = undefined; // Reset last known timestamp
                continue; // Skip further downtime calculation for this table
            }

            if (TotalWorked >= TotalPlan) {
                if (lastKnownTimestamps[table] && lastKnownTimestamps[table].model) {
                    const lastModel = lastKnownTimestamps[table].model;
                    ongoingDowntimeGauge.labels(table, lastModel, 'working_hours').set(0);
                    console.log(`[${new Date().toISOString()}] Line ${table}: Resetting downtime for model ${lastModel} because production plan is met.`);
                }

                console.log(`[${new Date().toISOString()}] Line ${table}: Actual production (${TotalWorked}) meets/exceeds plan (${TotalPlan}). Setting downtime to 0.`);
                ongoingDowntimeGauge.remove(table, '', 'no_production');
                ongoingDowntimeGauge.remove(table, '', 'no_production_data');
                lastKnownTimestamps[table] = undefined; // Reset last known timestamp
                continue; // Skip further downtime calculation for this table
            }

            // --- Daily Reset Logic ---
            if (lastKnownTimestamps[table] && moment.tz(lastKnownTimestamps[table].timestamp, 'America/New_York').isBefore(todayShiftStart)) {
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

                    lastKnownTimestamps[table] = { timestamp: lastTs, model: lastModel }; 
                } else {
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
                const [newRows] = await mysqlConnection.execute(sql, [moment.tz(lastKnownProdEvent.timestamp, 'America/New_York').format('YYYY-MM-DD HH:mm:ss')]);
                
                if (newRows.length > 0) {
                    let previousTimestampInBatch = lastKnownProdEvent.timestamp;
                    let previousModelInBatch = lastKnownProdEvent.model;

                    for (const currentProdEvent of newRows) {
                        const currentTimestamp = moment.tz(currentProdEvent.timestamp, 'America/New_York').toDate();
                        const currentModel = currentProdEvent.model || 'unknown';

                        if (currentModel !== previousModelInBatch) {
                            console.log(`[INFO] Model changed for line ${table}: from ${previousModelInBatch} to ${currentModel}. Resetting old model\'s working_hours downtime to 0.`);
                            ongoingDowntimeGauge.remove(table, previousModelInBatch, 'working_hours');
                        }

                        previousTimestampInBatch = currentTimestamp;
                        previousModelInBatch = currentModel;
                    }
                    lastKnownTimestamps[table] = { timestamp: previousTimestampInBatch, model: previousModelInBatch };
                }
            }

            // --- Ongoing downtime calculation (주야간 교대 및 휴게/연장 근무 분 단위 반영) ---
            const now = moment().tz('America/New_York');
            const currentHour = now.hours();
            const currentMinute = now.minutes();
            const currentTotalMinutes = currentHour * 60 + currentMinute;

            // 1. 근무 시간 판별 (분 단위 환산)
            // 주간조: 07:00 (420분) ~ 17:30 (1050분)
            const isDayShift = currentTotalMinutes >= 420 && currentTotalMinutes <= 1050;

            // 야간조 + 오버타임(새벽 4시까지): 17:30 (1050분) ~ 24:00, 그리고 00:00 ~ 04:00 (240분)
            const isNightShift = (currentTotalMinutes >= 1050 && currentTotalMinutes <= 1439) || 
                                 (currentTotalMinutes >= 0 && currentTotalMinutes <= 240);

            const isWorkingHours = isDayShift || isNightShift;

            // 2. 휴게(식사) 시간 판별
            // 주간 점심: 11:00 (660분) ~ 11:30 (690분)
            const isDayLunch = isDayShift && (currentTotalMinutes >= 660 && currentTotalMinutes < 690);

            // 야간 저녁: 21:30 (1290분) ~ 22:00 (1320분)
            const isNightDinner = isNightShift && (currentTotalMinutes >= 1290 && currentTotalMinutes < 1320);

            const isLunchBreak = isDayLunch || isNightDinner;

            // If it's not lunch break, ensure the lunch_break metric is removed.
            if (!isLunchBreak) {
                ongoingDowntimeGauge.remove(table, lastKnownTimestamps[table]?.model || '', 'lunch_break');
            }

            if (lastKnownTimestamps[table]) {
                const lastProdEvent = lastKnownTimestamps[table];
                const lastProductionTime = moment.tz(lastProdEvent.timestamp, 'America/New_York');
                const lastModel = lastProdEvent.model;

                lastProdTimeToLog = lastProductionTime.format('YYYY-MM-DD HH:mm:ss');
                if (isWorkingHours && !isLunchBreak) {
                    ongoingDowntimeGauge.remove(table, '', 'no_production');
                    ongoingDowntimeGauge.remove(table, '', 'production_complete');
                    ongoingDowntimeGauge.remove(table, '', 'no_production_data');

                    let effectiveLastProductionTime = lastProductionTime;
                    const lunchBreakEnd = moment(lastProductionTime).tz('America/New_York').hour(11).minute(30).second(0);

                    if (lastProductionTime.isBefore(lunchBreakEnd) && now.isAfter(lunchBreakEnd)) {
                        effectiveLastProductionTime = lunchBreakEnd;
                    }

                    const downtimeSeconds = now.diff(effectiveLastProductionTime, 'seconds');
                    downtimeToLog = downtimeSeconds > 0 ? downtimeSeconds : 0;
                    ongoingDowntimeGauge.labels(table, lastModel, 'working_hours').set(downtimeToLog);
                } else {
                    ongoingDowntimeGauge.labels(table, lastModel, 'working_hours').set(0);

                    let statusLabel = 'non_working_hours';
                    if (isLunchBreak) {
                        statusLabel = 'lunch_break';
                    }
                    downtimeToLog = 0;
                    ongoingDowntimeGauge.labels(table, lastModel, statusLabel).set(downtimeToLog);
                }
            } else {
                downtimeToLog = 0;
                ongoingDowntimeGauge.labels(table, '', 'no_production_data').set(downtimeToLog);
                ongoingDowntimeGauge.remove(table, '', 'no_production');
                ongoingDowntimeGauge.remove(table, '', 'production_complete');
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
        console.error('Database connection failed - Full Error:', error);
        console.error('Database connection failed - Message:', error.message);
        if (error.stack) {
            console.error('Database connection failed - Stack:', error.stack);
        }
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
    setInterval(checkDowntime, pollingInterval);
    checkDowntime();
});