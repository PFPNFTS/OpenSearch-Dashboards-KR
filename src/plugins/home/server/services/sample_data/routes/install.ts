/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * The OpenSearch Contributors require contributions made to
 * this file be licensed under the Apache-2.0 license or a
 * compatible open source license.
 *
 * Any modifications Copyright OpenSearch Contributors. See
 * GitHub history for details.
 */

/*
 * Licensed to Elasticsearch B.V. under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Elasticsearch B.V. licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { schema } from '@osd/config-schema';
import { IRouter, LegacyCallAPIOptions, Logger } from 'src/core/server';
import { SampleDatasetSchema } from '../lib/sample_dataset_registry_types';
import { createIndexName } from '../lib/create_index_name';
import {
  dateToIso8601IgnoringTime,
  translateTimeRelativeToDifference,
  translateTimeRelativeToWeek,
} from '../lib/translate_timestamp';
import { loadData } from '../lib/load_data';
import { SampleDataUsageTracker } from '../usage/usage';

const insertDataIntoIndex = (
  dataIndexConfig: any,
  index: string,
  nowReference: string,
  caller: (
    endpoint: string,
    clientParams?: Record<string, any>,
    options?: LegacyCallAPIOptions
  ) => Promise<any>,
  logger: Logger
) => {
  function updateTimestamps(doc: any) {
    dataIndexConfig.timeFields
      .filter((timeFieldName: string) => doc[timeFieldName])
      .forEach((timeFieldName: string) => {
        doc[timeFieldName] = dataIndexConfig.preserveDayOfWeekTimeOfDay
          ? translateTimeRelativeToWeek(
              doc[timeFieldName],
              dataIndexConfig.currentTimeMarker,
              nowReference
            )
          : translateTimeRelativeToDifference(
              doc[timeFieldName],
              dataIndexConfig.currentTimeMarker,
              nowReference
            );
      });
    return doc;
  }

  const bulkInsert = async (docs: any) => {
    const insertCmd = { index: { _index: index } };
    const bulk: any[] = [];
    docs.forEach((doc: any) => {
      bulk.push(insertCmd);
      bulk.push(updateTimestamps(doc));
    });

    const resp = await caller('bulk', {
      body: bulk,
    });
    if (resp.errors) {
      const errMsg = `sample_data install errors while bulk inserting. OpenSearch response: ${JSON.stringify(
        resp,
        null,
        ''
      )}`;
      logger.warn(errMsg);
      return Promise.reject(
        new Error(
          `Unable to load sample data into index "${index}", see OpenSearch Dashboards logs for details`
        )
      );
    }
  };
  return loadData(dataIndexConfig.dataPath, bulkInsert); // this returns a Promise
};

export function createInstallRoute(
  router: IRouter,
  sampleDatasets: SampleDatasetSchema[],
  logger: Logger,
  usageTracker: SampleDataUsageTracker
): void {
  router.post(
    {
      path: '/api/sample_data/{id}',
      validate: {
        params: schema.object({ id: schema.string() }),
        // TODO validate now as date
        query: schema.object({
          now: schema.maybe(schema.string()),
          data_source_id: schema.maybe(schema.string()),
        }),
      },
    },
    async (context, req, res) => {
      const { params, query } = req;
      const dataSourceId = query.data_source_id;

      const sampleDataset = sampleDatasets.find(({ id }) => id === params.id);
      if (!sampleDataset) {
        return res.notFound();
      }
      //  @ts-ignore Custom query validation used
      const now = query.now ? new Date(query.now) : new Date();
      const nowReference = dateToIso8601IgnoringTime(now);
      const counts = {};
      const caller = dataSourceId
        ? context.dataSource.opensearch.legacy.getClient(dataSourceId).callAPI
        : context.core.opensearch.legacy.client.callAsCurrentUser;

      let dataSourceTitle;
      try {
        if (dataSourceId) {
          const dataSource = await context.core.savedObjects.client
            .get('data-source', dataSourceId)
            .then((response) => {
              const attributes: any = response?.attributes || {};
              return {
                id: response.id,
                title: attributes.title,
              };
            });

          dataSourceTitle = dataSource.title;
        }
      } catch (err) {
        return res.internalError({ body: err });
      }

      for (let i = 0; i < sampleDataset.dataIndices.length; i++) {
        const dataIndexConfig = sampleDataset.dataIndices[i];
        const index = createIndexName(sampleDataset.id, dataIndexConfig.id);

        // clean up any old installation of dataset
        try {
          await caller('indices.delete', {
            index,
          });
        } catch (err) {
          // ignore delete errors
        }

        try {
          const createIndexParams = {
            index,
            body: {
              settings: dataSourceId
                ? { index: { number_of_shards: 1 } }
                : { index: { number_of_shards: 1, auto_expand_replicas: '0-1' } },
              mappings: { properties: dataIndexConfig.fields },
            },
          };
          await caller('indices.create', createIndexParams);
        } catch (err) {
          const errMsg = `Unable to create sample data index "${index}", error: ${err.message}`;
          logger.warn(errMsg);
          return res.customError({ body: errMsg, statusCode: err.status });
        }

        try {
          const count = await insertDataIntoIndex(
            dataIndexConfig,
            index,
            nowReference,
            caller,
            logger
          );
          (counts as any)[index] = count;
        } catch (err) {
          const errMsg = `sample_data install errors while loading data. Error: ${err}`;
          logger.warn(errMsg);
          return res.internalError({ body: errMsg });
        }
      }

      let createResults;
      const savedObjectsList = sampleDataset.savedObjects(dataSourceId, dataSourceTitle);

      try {
        createResults = await context.core.savedObjects.client.bulkCreate(
          savedObjectsList.map(({ version, ...savedObject }) => savedObject),
          { overwrite: true }
        );
      } catch (err) {
        const errMsg = `bulkCreate failed, error: ${err.message}`;
        logger.warn(errMsg);
        return res.internalError({ body: errMsg });
      }
      const errors = createResults.saved_objects.filter((savedObjectCreateResult) => {
        return Boolean(savedObjectCreateResult.error);
      });
      if (errors.length > 0) {
        const errMsg = `sample_data install errors while loading saved objects. Errors: ${errors.join(
          ','
        )}`;
        logger.warn(errMsg);
        return res.customError({ body: errMsg, statusCode: 403 });
      }
      usageTracker.addInstall(params.id);

      // FINALLY
      return res.ok({
        body: {
          opensearchIndicesCreated: counts,
          opensearchDashboardsSavedObjectsLoaded: savedObjectsList.length,
        },
      });
    }
  );
}
