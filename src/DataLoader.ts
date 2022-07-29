import * as cdsg from '@sap/cds';
const cds = cdsg as any;
const { fs, path, isdir, read } = cds.utils;
const { readdir } = fs.promises;

/**
 * Data loader class handling imports of csv files (json maybe added).
 * Logic is mainly derived from cds lib but enhanced to support delta loads.
 *
 * @see @sap/cds/lib/srv/db/deploy.js
 */
export class DataLoader {
  private deltaUpdate: boolean;
  private model: any;

  constructor(model, deltaUpdate: boolean) {
    this.deltaUpdate = deltaUpdate;
    this.model = model;
  }

  async load(pgClient) {
    const locations = ['data', 'csv'];
    if (!this.model.$sources) return;
    const folders = new Set();
    for (const model of this.model.$sources) {
      for (const data of locations) {
        for (const each of [model + data, model + '/../' + data]) {
          const folder = path.resolve(each);
          if (isdir(folder)) folders.add(folder);
        }
      }
    }

    if (folders.size === 0) return;
    for (const folder of folders) {
      const files = await readdir(folder);
      for (const each of files.filter(this._filterCsvFiles.bind(this))) {
        // Verify entity
        const name = each
          .replace(/-/g, '.')
          .slice(0, -path.extname(each).length);
        const entity = this._entity4(name);
        if (entity['@cds.persistence.skip'] === true) continue;
        // Load the content
        const file = path.join(folder, each);
        const src = await read(file, 'utf8');
        const [cols, ...rows] = cds.parse.csv(src);

        const valuesToInsert = rows
          .map((row) => `(${row.map((element) => `'${element}'`).join(',')})`)
          .join(',');
        const columns = cols.join(',');

        await pgClient.query(`
          INSERT INTO ${entity.name.replaceAll('.', '_')} (${columns})
          VALUES ${valuesToInsert}
          ON CONFLICT DO NOTHING;
        `);
      }
    }
  }

  /**
   *
   * @param filename
   * @param _
   * @param allFiles
   */
  private _filterCsvFiles(filename, _, allFiles) {
    if (filename[0] === '-' || !filename.endsWith('.csv')) return false;
    if (
      /_texts\.csv$/.test(filename) &&
      this._check_lang_file(filename, allFiles)
    ) {
      return false;
    }
    return true;
  }

  /**
   *
   * @param filename
   * @param allFiles
   */
  private _check_lang_file(filename, allFiles) {
    // ignores 'Books_texts.csv/json' if there is any 'Books_texts_LANG.csv/json'
    const basename = path.basename(filename);
    const monoLangFiles = allFiles.filter((file) =>
      new RegExp('^' + basename + '_').test(file),
    );
    if (monoLangFiles.length > 0) {
      //DEBUG && DEBUG (`ignoring '${filename}' in favor of [${monoLangFiles}]`)  // eslint-disable-line
      return true;
    }
    return false;
  }

  /**
   *
   * @param name
   */
  private _entity4(name) {
    const entity = this.model.definitions[name];
    if (!entity) {
      if (/(.+)_texts_?/.test(name)) {
        // 'Books_texts', 'Books_texts_de'
        const base = this.model.definitions[RegExp.$1];
        return base && this._entity4(base.elements.texts.target);
      } else return;
    }
    // We also support insert into simple views if they have no projection
    if (entity.query) {
      const { SELECT } = entity.query;
      if (
        SELECT &&
        !SELECT.columns &&
        SELECT.from.ref &&
        SELECT.from.ref.length === 1
      ) {
        if (this.model.definitions[SELECT.from.ref[0]]) return entity;
      }
    }
    return entity.name ? entity : { name, __proto__: entity };
  }
}
