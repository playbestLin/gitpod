/**
 * Copyright (c) 2023 Gitpod GmbH. All rights reserved.
 * Licensed under the GNU Affero General Public License (AGPL).
 * See License.AGPL.txt in the project root for license information.
 */

import { DisposableCollection } from "@gitpod/gitpod-protocol";
import { repeat } from "@gitpod/gitpod-protocol/lib/util/repeat";
import { inject, injectable } from "inversify";
import { RedisMutex } from "../redis/mutex";
import { log } from "@gitpod/gitpod-protocol/lib/util/logging";
import { ExecutionError, ResourceLockedError } from "redlock";
import { jobsDurationSeconds, reportJobCompleted, reportJobStarted } from "../prometheus-metrics";
import { DatabaseGarbageCollector } from "./database-gc";
import { OTSGarbageCollector } from "./ots-gc";
import { TokenGarbageCollector } from "./token-gc";
import { WebhookEventGarbageCollector } from "./webhook-gc";
import { WorkspaceGarbageCollector } from "./workspace-gc";
import { SnapshotsJob } from "./snapshots";
import { OrgOnlyMigrationJob } from "./org-only-migration-job";
import { JobStateDbImpl } from "@gitpod/gitpod-db/lib/typeorm/job-state-db-impl";
import { FixStripeJob } from "./fix-stripe-job";

export const Job = Symbol("Job");

export interface Job<T = any> {
    readonly name: string;
    readonly frequencyMs: number;
    readonly lockedResources?: string[];
    run: (previousState?: T) => Promise<T>;
}

@injectable()
export class JobRunner {
    @inject(RedisMutex) protected mutex: RedisMutex;

    @inject(DatabaseGarbageCollector) protected databaseGC: DatabaseGarbageCollector;
    @inject(OTSGarbageCollector) protected otsGC: OTSGarbageCollector;
    @inject(TokenGarbageCollector) protected tokenGC: TokenGarbageCollector;
    @inject(WebhookEventGarbageCollector) protected webhookGC: WebhookEventGarbageCollector;
    @inject(WorkspaceGarbageCollector) protected workspaceGC: WorkspaceGarbageCollector;
    @inject(SnapshotsJob) protected snapshotsJob: SnapshotsJob;
    @inject(OrgOnlyMigrationJob) protected orgOnlyMigrationJob: OrgOnlyMigrationJob;
    @inject(FixStripeJob) protected fixStripeJob: FixStripeJob;
    @inject(JobStateDbImpl) protected jobStateDb: JobStateDbImpl;

    public start(): DisposableCollection {
        const disposables = new DisposableCollection();

        const jobs: Job[] = [
            this.databaseGC,
            this.otsGC,
            this.tokenGC,
            this.webhookGC,
            this.workspaceGC,
            this.snapshotsJob,
            this.orgOnlyMigrationJob,
            this.fixStripeJob,
        ];

        for (let job of jobs) {
            log.info(`Registered job ${job.name} in job runner.`, {
                jobName: job.name,
                frequencyMs: job.frequencyMs,
                lockedResources: job.lockedResources,
            });
            // immediately run the job once
            this.run(job).catch((err) => log.error(`Error while running job ${job.name}`, err));
            disposables.push(repeat(() => this.run(job), job.frequencyMs));
        }

        return disposables;
    }

    private async run(job: Job): Promise<void> {
        const logCtx = {
            jobTickId: new Date().toISOString(),
            jobName: job.name,
            lockedResources: job.lockedResources,
            frequencyMs: job.frequencyMs,
        };

        try {
            await this.mutex.using([job.name, ...(job.lockedResources || [])], job.frequencyMs, async (signal) => {
                log.info(`Acquired lock for job ${job.name}.`, logCtx);
                // we want to hold the lock for the entire duration of the job, so we return earliest after frequencyMs
                const timeout = new Promise<void>((resolve) => setTimeout(resolve, job.frequencyMs));
                const timer = jobsDurationSeconds.startTimer({ name: job.name });
                reportJobStarted(job.name);
                const now = new Date().getTime();
                try {
                    const stateBefore = await this.jobStateDb.getState(job.name);
                    const stateAfter = await job.run(stateBefore?.state);
                    if (stateAfter !== undefined && typeof stateAfter === "object") {
                        await this.jobStateDb.setState(job.name, stateAfter);
                    }
                    log.info(`Successfully finished job ${job.name}`, {
                        ...logCtx,
                        jobTookSec: `${(new Date().getTime() - now) / 1000}s`,
                    });
                    reportJobCompleted(job.name, true);
                } catch (err) {
                    log.error(`Error while running job ${job.name}`, err, {
                        ...logCtx,
                        jobTookSec: `${(new Date().getTime() - now) / 1000}s`,
                    });
                    reportJobCompleted(job.name, false);
                } finally {
                    jobsDurationSeconds.observe(timer());
                    await timeout;
                }
            });
        } catch (err) {
            if (err instanceof ResourceLockedError || err instanceof ExecutionError) {
                log.debug(
                    `Failed to acquire lock for job ${job.name}. Likely another instance already holds the lock.`,
                    err,
                    logCtx,
                );
                return;
            }

            log.error(`Failed to acquire lock for job ${job.name}`, err, logCtx);
        }
    }
}
