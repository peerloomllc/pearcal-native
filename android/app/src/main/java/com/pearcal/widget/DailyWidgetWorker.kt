package com.pearcal.widget

import android.content.Context
import androidx.work.*
import java.util.concurrent.TimeUnit

class DailyWidgetWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
    override fun doWork(): Result {
        DailyWidgetReceiver.updateAll(applicationContext)
        return Result.success()
    }

    companion object {
        private const val WORK_NAME = "pearcal_daily_widget_refresh"

        fun schedule(context: Context) {
            val req = PeriodicWorkRequestBuilder<DailyWidgetWorker>(15, TimeUnit.MINUTES).build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, req
            )
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME)
        }
    }
}
