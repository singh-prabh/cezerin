'use strict';

const path = require('path');
const url = require('url');
const settings = require('../../lib/settings');
const SettingsService = require('../settings/settings');
var mongo = require('../../lib/mongo');
var utils = require('../../lib/utils');
var parse = require('../../lib/parse');
var ObjectID = require('mongodb').ObjectID;
var formidable = require('formidable');
var fs = require('fs-extra');

class ProductCategoriesService {
  constructor() {}

  getFilter(params = {}) {
    let filter = {};
    const enabled = parse.getBooleanIfValid(params.enabled);
    if (enabled !== null) {
      filter.enabled = enabled;
    }
    const id = parse.getObjectIDIfValid(params.id);
    if (id) {
      filter._id = new ObjectID(id);
    }
    return filter;
  }

  getCategories(params = {}) {
    const filter = this.getFilter(params);
    return SettingsService.getSettings().then(generalSettings =>
      mongo.db.collection('productCategories').find(filter).sort({position: 1}).toArray()
      .then(items => items.map(c => this.changeProperties(c, generalSettings.domain)))
    );
  }

  getSingleCategory(id) {
    if (!ObjectID.isValid(id)) {
      return Promise.reject('Invalid identifier');
    }
    return this.getCategories({id: id}).then(categories => {
      return categories.length > 0
        ? categories[0]
        : null;
    })
  }

  addCategory(data) {
    return mongo.db.collection('productCategories').find().sort({position:-1}).limit(1).nextObject()
    .then(item => {
      const newPosition = (item && item.position > 0) ? item.position + 1 : 1;

      return this.getValidDocumentForInsert(data, newPosition).then(dataToInsert =>
        mongo.db.collection('productCategories')
          .insertMany([dataToInsert])
          .then(res => this.getSingleCategory(res.ops[0]._id.toString())));
    });
  }

  updateCategory(id, data) {
    if(!ObjectID.isValid(id)) {
      return Promise.reject('Invalid identifier');
    }
    let categoryObjectID = new ObjectID(id);

    return this.getValidDocumentForUpdate(id, data)
      .then(dataToSet => mongo.db.collection('productCategories').updateOne({ _id: categoryObjectID }, {$set: dataToSet}))
      .then(res => res.modifiedCount > 0 ? this.getSingleCategory(id) : null)
  }

  findAllChildren(items, id, result) {
    if(id && ObjectID.isValid(id)) {
      result.push(new ObjectID(id));
      let finded = items.filter(item => (item.parent_id === id));
      if(finded.length > 0) {
        for(let item of finded) {
          this.findAllChildren(items, item.id, result);
        }
      }
    }

    return result;
  }

  deleteCategory(id) {
    if(!ObjectID.isValid(id)) {
      return Promise.reject('Invalid identifier');
    }

    // 1. get all categories
    return this.getCategories()
    .then(items => {
      // 2. find category and children
      var idsToDelete = [];
      this.findAllChildren(items, id, idsToDelete);
      return idsToDelete;
    })
    .then(idsToDelete => {
      // 3. delete categories
      let objectsToDelete = idsToDelete.map((id) => ( new ObjectID(id) ));
      // return mongo.db.collection('productCategories').deleteMany({_id: { $in: objectsToDelete}}).then(() => idsToDelete);
      return mongo.db.collection('productCategories').deleteMany({_id: { $in: objectsToDelete}}).then(deleteResponse => deleteResponse.deletedCount > 0 ? idsToDelete : null);
    })
    .then(idsToDelete => {
      // 4. update category_id for products
      return idsToDelete ? mongo.db.collection('products').updateMany({ category_id: { $in: idsToDelete}}, { $set: { category_id: null }}).then(() => idsToDelete) : null;
    })
    .then(idsToDelete => {
      // 5. delete directories with images
      if(idsToDelete) {
        for(let categoryId of idsToDelete) {
          let deleteDir = path.resolve(settings.categoriesUploadPath + '/' + categoryId);
          fs.remove(deleteDir, err => {});
        }
        return Promise.resolve(true);
      } else {
        return Promise.resolve(false);
      }
    });
  }

  getErrorMessage(err) {
    return { 'error': true, 'message': err.toString() };
  }

  getValidDocumentForInsert(data, newPosition) {
      //  Allow empty category to create draft

      let category = {
        'date_created': new Date(),
        'date_updated': null,
        'image': ''
      };

      category.name = parse.getString(data.name);
      category.description = parse.getString(data.description);
      category.meta_description = parse.getString(data.meta_description);
      category.meta_title = parse.getString(data.meta_title);
      category.enabled = parse.getBooleanIfValid(data.enabled, true);
      category.sort = parse.getString(data.sort);
      category.parent_id = parse.getObjectIDIfValid(data.parent_id);
      category.position = parse.getNumberIfValid(data.position) || newPosition;

      let slug = (!data.slug || data.slug.length === 0) ? data.name : data.slug;
      if(!slug || slug.length === 0) {
        return Promise.resolve(category);
      } else {
        return utils.getAvailableSlug(slug).then(newSlug => {
          category.slug = newSlug;
          return category;
        });
      }
  }

  getValidDocumentForUpdate(id, data) {
    return new Promise((resolve, reject) => {
      if(!ObjectID.isValid(id)) {
        reject('Invalid identifier');
      }
      if (Object.keys(data).length === 0) {
        reject('Required fields are missing');
      }

      let category = {
        'date_updated': new Date()
      };

      if(data.name !== undefined) {
        category.name = parse.getString(data.name);
      }

      if(data.description !== undefined) {
        category.description = parse.getString(data.description);
      }

      if(data.meta_description !== undefined) {
        category.meta_description = parse.getString(data.meta_description);
      }

      if(data.meta_title !== undefined) {
        category.meta_title = parse.getString(data.meta_title);
      }

      if(data.enabled !== undefined) {
        category.enabled = parse.getBooleanIfValid(data.enabled, true);
      }

      if(data.image !== undefined) {
        category.image = data.image;
      }

      if(data.position >= 0) {
        category.position = data.position;
      }

      if(data.sort !== undefined) {
        category.sort = data.sort;
      }

      if(data.parent_id !== undefined) {
        category.parent_id = parse.getObjectIDIfValid(data.parent_id);
      }



      if(data.slug !== undefined){
        let slug = data.slug;
        if(!slug || slug.length === 0) {
          slug = data.name;
        }

        utils.getAvailableSlug(slug, id)
        .then((newSlug) => {
          category.slug = newSlug;
          resolve(category);
        })
        .catch((err) => {
          reject(err);
        });

      } else {
        resolve(category);
      }
    });
  }

  changeProperties(item, domain) {
    if(item) {
      item.id = item._id.toString();
      delete item._id;

      if(item.parent_id) {
        item.parent_id = item.parent_id.toString();
      }

      item.url = url.resolve(domain, item.slug || '');
      item.path = url.resolve('/', item.slug || '');

      if(item.image) {
        item.image = url.resolve(domain, settings.categoriesUploadUrl + '/' + item.id + '/' + item.image);
      }
    }

    return item;
  }

  deleteCategoryImage(id) {
    let dir = path.resolve(settings.categoriesUploadPath + '/' + id);
    fs.emptyDirSync(dir);
    this.updateCategory(id, { 'image': '' });
  }

  uploadCategoryImage(req, res) {
    let categoryId = req.params.id;
    let form = new formidable.IncomingForm(),
        file_name = null,
        file_size = 0;

    form
      .on('fileBegin', (name, file) => {
        // Emitted whenever a field / value pair has been received.
        let dir = path.resolve(settings.categoriesUploadPath + '/' + categoryId);
        fs.emptyDirSync(dir);
        file.path = dir + '/' + file.name;
      })
      .on('file', function(field, file) {
        // every time a file has been uploaded successfully,
        file_name = file.name;
        file_size = file.size;
      })
      .on('error', (err) => {
        res.status(500).send(this.getErrorMessage(err));
      })
      .on('end', () => {
        //Emitted when the entire request has been received, and all contained files have finished flushing to disk.
        if(file_name) {
          this.updateCategory(categoryId, { 'image': file_name });
          res.send({ 'file': file_name, 'size': file_size });
        } else {
          res.status(400).send(this.getErrorMessage('Required fields are missing'));
        }
      });

    form.parse(req);
  }

}

module.exports = new ProductCategoriesService();
