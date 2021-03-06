/**
 * This program and the accompanying materials are made available under the terms of the
 * Eclipse Public License v2.0 which accompanies this distribution, and is available at
 * https://www.eclipse.org/legal/epl-v20.html
 *
 * SPDX-License-Identifier: EPL-2.0
 *
 * Copyright IBM Corporation 2020
 */

import ZMSBaseWorker from "./base";
import RmfDds from "../rmf/dds";
import {
  MetricWorker,
  ZMSRmfDdsWorkerOptions, PartialZMSRmfDdsWorkerOptions,
  MetricWorkerResultItem,
} from "../../types";
import { DEFAULT_RMF_DDS_OPTIONS, DEFAULT_RMF_DDS_METRICS } from "../../constants";
import logger from "../logger";
import metricsManager from "../metrics-manager";

export default class ZMSRmfDdsWorker extends ZMSBaseWorker {
  protected options: ZMSRmfDdsWorkerOptions;

  protected rmfDds: RmfDds;

  constructor(name: string, options: PartialZMSRmfDdsWorkerOptions) {
    super(name, options);

    if (!this.options.rmfDdsOptions) {
      this.options.rmfDdsOptions = DEFAULT_RMF_DDS_OPTIONS;
    }
    this.rmfDds = new RmfDds(this.options.rmfDdsOptions);

    if (!this.options.metrics) {
      this.options.metrics = DEFAULT_RMF_DDS_METRICS;
    }
  }

  async prepare(): Promise<void> {
    await super.prepare();

    // prepare metrics resource map
    logger.debug("rmf-dds worker preparing metric-resource map")
    await this.rmfDds.getMetricResourceMap();
  }

  async poll(): Promise<void> {
    try {
      logger.debug("rmf-dds worker \"%s\" polling: %s", this.name, this.rmfDds.getPrefixUrl());

      const ts = new Date();
      const result: MetricWorkerResultItem[] = [];
      
      for (const metric in this.options.metrics) {
        const keys = this.options.metrics[metric];
        for (const key of keys) {
          const perform = await this.rmfDds.getMetricPerformance(key);
          logger.silly("rmf-dds worker \"%s\" %s(%s) output: %j", this.name, metric, key, perform);

          for (const row of perform.rows) {
            if (row.value === "NaN" || row.item.toLowerCase().indexOf('nodata') > -1) {
              continue;
            }

            const value = parseFloat(`${row.value}`);
            if (isNaN(value)) {
              logger.warn("Error on executing rmf-dds worker \"%s\" on \"%s\": value of metric %s(%s) \"%j\" is not a number", this.name, this.rmfDds.getPrefixUrl(), metric, key, row);
              continue;
            }

            const item: MetricWorkerResultItem = {
              key: metric,
              value,
            };

            if (row.item) {
              item.item = row.item;
            }
            if (row.extra && Array.isArray(row.extra) && row.extra.length > 0) {
              item.extra = row.extra.join(",");
            }

            result.push(item);
          }
        }
      }

      logger.info("rmf-dds worker \"%s\" returns %d records", this.name, result.length);
      this._fixMissingCpuPr(result);
      logger.silly("rmf-dds worker \"%s\" parsed result: %j", this.name, result);
      metricsManager.updateResult(this.name, ts, result);
    } catch (e) {
      logger.warn("Error on executing rmf-dds worker \"%s\" on \"%s\": %j - %j - %j", this.name, this.rmfDds.getPrefixUrl(), e, e.message, e.stack);
      // log the error but do not exit
    }
  }

  private _findCpuPrItems(data: MetricWorkerResultItem[]): string[] {
    const result: string[] = [];

    for (const item of data) {
      if (item.key === "cpupr") {
        if (item.item) {
          result.push(`${item.item}||${item.extra ? item.extra : ""}`);
        }
      }
    }

    return result;
  }

  private _fixMissingCpuPr(data: MetricWorkerResultItem[]): void {
    const lastWorkerResult: MetricWorker = (this.name in metricsManager.metrics) ? metricsManager.metrics[this.name] : null;
    const lastResult: MetricWorkerResultItem[] = lastWorkerResult && lastWorkerResult.resultRaw ? lastWorkerResult.resultRaw : [];

    const lastProcesses: string[] = this._findCpuPrItems(lastResult);
    const thisProcesses: string[] = this._findCpuPrItems(data);
    const missingProcesses: string[] = lastProcesses.filter(m => thisProcesses.indexOf(m) == -1);
    logger.debug("These processes will be added to %s cpupr and set to 0: %j", this.name, missingProcesses);

    for (const m of missingProcesses) {
      const sm = m.split("||");
      if (sm[0]) {
        const newItem: MetricWorkerResultItem = {
          key: "cpupr",
          // set to 0 if it's missing
          value: 0,
          item: sm[0],
        };
        if (sm[1]) {
          newItem.extra = sm[1];
        }

        data.push(newItem);
      }
    }
  }
}
