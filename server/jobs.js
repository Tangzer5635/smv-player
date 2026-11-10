const {randomId} = require('./utils');

/*
 * Tâches longues (chargement d'un portail, téléchargement d'une liste M3U)
 * suivies par le client via GET /api/jobs/:id.
 */

const RETENTION_MS = 10 * 60 * 1000;

class JobManager {
    constructor() {
        this.jobs = new Map();
        this.timer = setInterval(() => this.prune(), 60 * 1000);
        this.timer.unref();
    }

    start(label, fn) {
        const job = {
            id: randomId(9),
            label,
            status: 'running',
            progress: {message: 'Démarrage…'},
            result: null,
            error: null,
            finishedAt: null,
        };
        this.jobs.set(job.id, job);
        Promise.resolve()
            .then(() => fn((progress) => {
                job.progress = progress;
            }))
            .then((result) => {
                job.status = 'done';
                job.result = result ?? null;
            })
            .catch((err) => {
                console.error(`❌ ${label}:`, err.message);
                job.status = 'error';
                job.error = err.message;
            })
            .finally(() => {
                job.finishedAt = Date.now();
            });
        return job;
    }

    get(id) {
        return this.jobs.get(id) || null;
    }

    describe(job) {
        return {
            id: job.id,
            label: job.label,
            status: job.status,
            progress: job.progress,
            error: job.error,
            result: job.status === 'done' ? job.result : null,
        };
    }

    prune() {
        const now = Date.now();
        for (const [id, job] of this.jobs) {
            if (job.finishedAt && now - job.finishedAt > RETENTION_MS) this.jobs.delete(id);
        }
    }

    stop() {
        clearInterval(this.timer);
    }
}

module.exports = {JobManager};
