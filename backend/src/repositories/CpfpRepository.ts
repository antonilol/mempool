import cluster, { Cluster } from 'cluster';
import { RowDataPacket } from 'mysql2';
import DB from '../database';
import logger from '../logger';
import { Ancestor } from '../mempool.interfaces';
import transactionRepository from '../repositories/TransactionRepository';

class CpfpRepository {
  public async $saveCluster(clusterRoot: string, height: number, txs: Ancestor[], effectiveFeePerVsize: number): Promise<boolean> {
    if (!txs[0]) {
      return false;
    }
    // skip clusters of transactions with the same fees
    const roundedEffectiveFee = Math.round(effectiveFeePerVsize * 100) / 100;
    const equalFee = txs.reduce((acc, tx) => {
      return (acc && Math.round(((tx.fee || 0) / (tx.weight / 4)) * 100) / 100 === roundedEffectiveFee);
    }, true);
    if (equalFee) {
      return false;
    }

    try {
      const packedTxs = Buffer.from(this.pack(txs));
      await DB.query(
        `
          INSERT INTO compact_cpfp_clusters(root, height, txs, fee_rate)
          VALUE (UNHEX(?), ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            height = ?,
            txs = ?,
            fee_rate = ?
        `,
        [clusterRoot, height, packedTxs, effectiveFeePerVsize, height, packedTxs, effectiveFeePerVsize]
      );
      const maxChunk = 10;
      let chunkIndex = 0;
      while (chunkIndex < txs.length) {
        const chunk = txs.slice(chunkIndex, chunkIndex + maxChunk).map(tx => {
          return { txid: tx.txid, cluster: clusterRoot };
        });
        await transactionRepository.$batchSetCluster(chunk);
        chunkIndex += maxChunk;
      }
      return true;
    } catch (e: any) {
      logger.err(`Cannot save cpfp cluster into db. Reason: ` + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  public async $batchSaveClusters(clusters: { root: string, height: number, txs: any, effectiveFeePerVsize: number}[]): Promise<boolean> {
    try {
      const clusterValues: any[] = [];
      const txs: any[] = [];

      for (const cluster of clusters) {
        if (cluster.txs?.length > 1) {
          const roundedEffectiveFee = Math.round(cluster.effectiveFeePerVsize * 100) / 100;
          const equalFee = cluster.txs.reduce((acc, tx) => {
            return (acc && Math.round(((tx.fee || 0) / (tx.weight / 4)) * 100) / 100 === roundedEffectiveFee);
          }, true);
          if (!equalFee) {
            clusterValues.push([
              cluster.root,
              cluster.height,
              Buffer.from(this.pack(cluster.txs)),
              cluster.effectiveFeePerVsize
            ]);
            for (const tx of cluster.txs) {
              txs.push({ txid: tx.txid, cluster: cluster.root });
            }
          }
        }
      }

      if (!clusterValues.length) {
        return false;
      }

      const maxChunk = 100;
      let chunkIndex = 0;
      // insert transactions in batches of up to 100 rows
      while (chunkIndex < txs.length) {
        const chunk = txs.slice(chunkIndex, chunkIndex + maxChunk);
        await transactionRepository.$batchSetCluster(chunk);
        chunkIndex += maxChunk;
      }

      chunkIndex = 0;
      // insert clusters in batches of up to 100 rows
      while (chunkIndex < clusterValues.length) {
        const chunk = clusterValues.slice(chunkIndex, chunkIndex + maxChunk);
        let query = `
            INSERT IGNORE INTO compact_cpfp_clusters(root, height, txs, fee_rate)
            VALUES
        `;
        query += chunk.map(chunk => {
          return (' (UNHEX(?), ?, ?, ?)');
        }) + ';';
        const values = chunk.flat();
        await DB.query(
          query,
          values
        );
        chunkIndex += maxChunk;
      }
      return true;
    } catch (e: any) {
      logger.err(`Cannot save cpfp clusters into db. Reason: ` + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  public async $getCluster(clusterRoot: string): Promise<Cluster> {
    const [clusterRows]: any = await DB.query(
      `
        SELECT *
        FROM compact_cpfp_clusters
        WHERE root = UNHEX(?)
      `,
      [clusterRoot]
    );
    const cluster = clusterRows[0];
    cluster.txs = this.unpack(cluster.txs);
    return cluster;
  }

  public async $deleteClustersFrom(height: number): Promise<void> {
    logger.info(`Delete newer cpfp clusters from height ${height} from the database`);
    try {
      const [rows] = await DB.query(
        `
          SELECT txs, height, root from compact_cpfp_clusters
          WHERE height >= ?
        `,
        [height]
      ) as RowDataPacket[][];
      if (rows?.length) {
        for (let clusterToDelete of rows) {
          const txs = this.unpack(clusterToDelete.txs);
          for (let tx of txs) {
            await transactionRepository.$removeTransaction(tx.txid);
          }
        }
      }
      await DB.query(
        `
          DELETE from compact_cpfp_clusters
          WHERE height >= ?
        `,
        [height]
      );
    } catch (e: any) {
      logger.err(`Cannot delete cpfp clusters from db. Reason: ` + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  // insert a dummy row to mark that we've indexed as far as this block
  public async $insertProgressMarker(height: number): Promise<void> {
    try {
      const [rows]: any = await DB.query(
        `
          SELECT root
          FROM compact_cpfp_clusters
          WHERE height = ?
        `,
        [height]
      );
      if (!rows?.length) {
        const rootBuffer = Buffer.alloc(32);
        rootBuffer.writeInt32LE(height);
        await DB.query(
          `
            INSERT INTO compact_cpfp_clusters(root, height, fee_rate)
            VALUE (?, ?, ?)
          `,
          [rootBuffer, height, 0]
        );
      }
    } catch (e: any) {
      logger.err(`Cannot insert cpfp progress marker. Reason: ` + (e instanceof Error ? e.message : e));
      throw e;
    }
  }

  public pack(txs: Ancestor[]): ArrayBuffer {
    const buf = new ArrayBuffer(44 * txs.length);
    const view = new DataView(buf);
    txs.forEach((tx, i) => {
      const offset = i * 44;
      for (let x = 0; x < 32; x++) {
        // store txid in little-endian
        view.setUint8(offset + (31 - x), parseInt(tx.txid.slice(x * 2, (x * 2) + 2), 16));
      }
      view.setUint32(offset + 32, tx.weight);
      view.setBigUint64(offset + 36, BigInt(Math.round(tx.fee)));
    });
    return buf;
  }

  public unpack(buf: Buffer): Ancestor[] {
    if (!buf) {
      return [];
    }

    const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const txs: Ancestor[] = [];
    const view = new DataView(arrayBuffer);
    for (let offset = 0; offset < arrayBuffer.byteLength; offset += 44) {
      const txid = Array.from(new Uint8Array(arrayBuffer, offset, 32)).reverse().map(b => b.toString(16).padStart(2, '0')).join('');
      const weight = view.getUint32(offset + 32);
      const fee = Number(view.getBigUint64(offset + 36));
      txs.push({
        txid,
        weight,
        fee
      });
    }
    return txs;
  }
}

export default new CpfpRepository();