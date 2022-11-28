(function () {

/* Imports */
var Meteor = Package.meteor.Meteor;
var global = Package.meteor.global;
var meteorEnv = Package.meteor.meteorEnv;
var DiffSequence = Package['diff-sequence'].DiffSequence;
var ECMAScript = Package.ecmascript.ECMAScript;
var EJSON = Package.ejson.EJSON;
var GeoJSON = Package['geojson-utils'].GeoJSON;
var IdMap = Package['id-map'].IdMap;
var MongoID = Package['mongo-id'].MongoID;
var OrderedDict = Package['ordered-dict'].OrderedDict;
var Random = Package.random.Random;
var Tracker = Package.tracker.Tracker;
var Deps = Package.tracker.Deps;
var Decimal = Package['mongo-decimal'].Decimal;
var meteorInstall = Package.modules.meteorInstall;
var Promise = Package.promise.Promise;

/* Package-scope variables */
var operand, selectorValue, MinimongoTest, MinimongoError, selector, doc, callback, options, oldResults, a, b, LocalCollection, Minimongo;

var require = meteorInstall({"node_modules":{"meteor":{"minimongo":{"minimongo_server.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/minimongo/minimongo_server.js                                                                              //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
module.link("./minimongo_common.js");
let hasOwn, isNumericKey, isOperatorObject, pathsToTree, projectionDetails;
module.link("./common.js", {
  hasOwn(v) {
    hasOwn = v;
  },

  isNumericKey(v) {
    isNumericKey = v;
  },

  isOperatorObject(v) {
    isOperatorObject = v;
  },

  pathsToTree(v) {
    pathsToTree = v;
  },

  projectionDetails(v) {
    projectionDetails = v;
  }

}, 0);

Minimongo._pathsElidingNumericKeys = paths => paths.map(path => path.split('.').filter(part => !isNumericKey(part)).join('.')); // Returns true if the modifier applied to some document may change the result
// of matching the document by selector
// The modifier is always in a form of Object:
//  - $set
//    - 'a.b.22.z': value
//    - 'foo.bar': 42
//  - $unset
//    - 'abc.d': 1


Minimongo.Matcher.prototype.affectedByModifier = function (modifier) {
  // safe check for $set/$unset being objects
  modifier = Object.assign({
    $set: {},
    $unset: {}
  }, modifier);

  const meaningfulPaths = this._getPaths();

  const modifiedPaths = [].concat(Object.keys(modifier.$set), Object.keys(modifier.$unset));
  return modifiedPaths.some(path => {
    const mod = path.split('.');
    return meaningfulPaths.some(meaningfulPath => {
      const sel = meaningfulPath.split('.');
      let i = 0,
          j = 0;

      while (i < sel.length && j < mod.length) {
        if (isNumericKey(sel[i]) && isNumericKey(mod[j])) {
          // foo.4.bar selector affected by foo.4 modifier
          // foo.3.bar selector unaffected by foo.4 modifier
          if (sel[i] === mod[j]) {
            i++;
            j++;
          } else {
            return false;
          }
        } else if (isNumericKey(sel[i])) {
          // foo.4.bar selector unaffected by foo.bar modifier
          return false;
        } else if (isNumericKey(mod[j])) {
          j++;
        } else if (sel[i] === mod[j]) {
          i++;
          j++;
        } else {
          return false;
        }
      } // One is a prefix of another, taking numeric fields into account


      return true;
    });
  });
}; // @param modifier - Object: MongoDB-styled modifier with `$set`s and `$unsets`
//                           only. (assumed to come from oplog)
// @returns - Boolean: if after applying the modifier, selector can start
//                     accepting the modified value.
// NOTE: assumes that document affected by modifier didn't match this Matcher
// before, so if modifier can't convince selector in a positive change it would
// stay 'false'.
// Currently doesn't support $-operators and numeric indices precisely.


Minimongo.Matcher.prototype.canBecomeTrueByModifier = function (modifier) {
  if (!this.affectedByModifier(modifier)) {
    return false;
  }

  if (!this.isSimple()) {
    return true;
  }

  modifier = Object.assign({
    $set: {},
    $unset: {}
  }, modifier);
  const modifierPaths = [].concat(Object.keys(modifier.$set), Object.keys(modifier.$unset));

  if (this._getPaths().some(pathHasNumericKeys) || modifierPaths.some(pathHasNumericKeys)) {
    return true;
  } // check if there is a $set or $unset that indicates something is an
  // object rather than a scalar in the actual object where we saw $-operator
  // NOTE: it is correct since we allow only scalars in $-operators
  // Example: for selector {'a.b': {$gt: 5}} the modifier {'a.b.c':7} would
  // definitely set the result to false as 'a.b' appears to be an object.


  const expectedScalarIsObject = Object.keys(this._selector).some(path => {
    if (!isOperatorObject(this._selector[path])) {
      return false;
    }

    return modifierPaths.some(modifierPath => modifierPath.startsWith("".concat(path, ".")));
  });

  if (expectedScalarIsObject) {
    return false;
  } // See if we can apply the modifier on the ideally matching object. If it
  // still matches the selector, then the modifier could have turned the real
  // object in the database into something matching.


  const matchingDocument = EJSON.clone(this.matchingDocument()); // The selector is too complex, anything can happen.

  if (matchingDocument === null) {
    return true;
  }

  try {
    LocalCollection._modify(matchingDocument, modifier);
  } catch (error) {
    // Couldn't set a property on a field which is a scalar or null in the
    // selector.
    // Example:
    // real document: { 'a.b': 3 }
    // selector: { 'a': 12 }
    // converted selector (ideal document): { 'a': 12 }
    // modifier: { $set: { 'a.b': 4 } }
    // We don't know what real document was like but from the error raised by
    // $set on a scalar field we can reason that the structure of real document
    // is completely different.
    if (error.name === 'MinimongoError' && error.setPropertyError) {
      return false;
    }

    throw error;
  }

  return this.documentMatches(matchingDocument).result;
}; // Knows how to combine a mongo selector and a fields projection to a new fields
// projection taking into account active fields from the passed selector.
// @returns Object - projection object (same as fields option of mongo cursor)


Minimongo.Matcher.prototype.combineIntoProjection = function (projection) {
  const selectorPaths = Minimongo._pathsElidingNumericKeys(this._getPaths()); // Special case for $where operator in the selector - projection should depend
  // on all fields of the document. getSelectorPaths returns a list of paths
  // selector depends on. If one of the paths is '' (empty string) representing
  // the root or the whole document, complete projection should be returned.


  if (selectorPaths.includes('')) {
    return {};
  }

  return combineImportantPathsIntoProjection(selectorPaths, projection);
}; // Returns an object that would match the selector if possible or null if the
// selector is too complex for us to analyze
// { 'a.b': { ans: 42 }, 'foo.bar': null, 'foo.baz': "something" }
// => { a: { b: { ans: 42 } }, foo: { bar: null, baz: "something" } }


Minimongo.Matcher.prototype.matchingDocument = function () {
  // check if it was computed before
  if (this._matchingDocument !== undefined) {
    return this._matchingDocument;
  } // If the analysis of this selector is too hard for our implementation
  // fallback to "YES"


  let fallback = false;
  this._matchingDocument = pathsToTree(this._getPaths(), path => {
    const valueSelector = this._selector[path];

    if (isOperatorObject(valueSelector)) {
      // if there is a strict equality, there is a good
      // chance we can use one of those as "matching"
      // dummy value
      if (valueSelector.$eq) {
        return valueSelector.$eq;
      }

      if (valueSelector.$in) {
        const matcher = new Minimongo.Matcher({
          placeholder: valueSelector
        }); // Return anything from $in that matches the whole selector for this
        // path. If nothing matches, returns `undefined` as nothing can make
        // this selector into `true`.

        return valueSelector.$in.find(placeholder => matcher.documentMatches({
          placeholder
        }).result);
      }

      if (onlyContainsKeys(valueSelector, ['$gt', '$gte', '$lt', '$lte'])) {
        let lowerBound = -Infinity;
        let upperBound = Infinity;
        ['$lte', '$lt'].forEach(op => {
          if (hasOwn.call(valueSelector, op) && valueSelector[op] < upperBound) {
            upperBound = valueSelector[op];
          }
        });
        ['$gte', '$gt'].forEach(op => {
          if (hasOwn.call(valueSelector, op) && valueSelector[op] > lowerBound) {
            lowerBound = valueSelector[op];
          }
        });
        const middle = (lowerBound + upperBound) / 2;
        const matcher = new Minimongo.Matcher({
          placeholder: valueSelector
        });

        if (!matcher.documentMatches({
          placeholder: middle
        }).result && (middle === lowerBound || middle === upperBound)) {
          fallback = true;
        }

        return middle;
      }

      if (onlyContainsKeys(valueSelector, ['$nin', '$ne'])) {
        // Since this._isSimple makes sure $nin and $ne are not combined with
        // objects or arrays, we can confidently return an empty object as it
        // never matches any scalar.
        return {};
      }

      fallback = true;
    }

    return this._selector[path];
  }, x => x);

  if (fallback) {
    this._matchingDocument = null;
  }

  return this._matchingDocument;
}; // Minimongo.Sorter gets a similar method, which delegates to a Matcher it made
// for this exact purpose.


Minimongo.Sorter.prototype.affectedByModifier = function (modifier) {
  return this._selectorForAffectedByModifier.affectedByModifier(modifier);
};

Minimongo.Sorter.prototype.combineIntoProjection = function (projection) {
  return combineImportantPathsIntoProjection(Minimongo._pathsElidingNumericKeys(this._getPaths()), projection);
};

function combineImportantPathsIntoProjection(paths, projection) {
  const details = projectionDetails(projection); // merge the paths to include

  const tree = pathsToTree(paths, path => true, (node, path, fullPath) => true, details.tree);
  const mergedProjection = treeToPaths(tree);

  if (details.including) {
    // both selector and projection are pointing on fields to include
    // so we can just return the merged tree
    return mergedProjection;
  } // selector is pointing at fields to include
  // projection is pointing at fields to exclude
  // make sure we don't exclude important paths


  const mergedExclProjection = {};
  Object.keys(mergedProjection).forEach(path => {
    if (!mergedProjection[path]) {
      mergedExclProjection[path] = false;
    }
  });
  return mergedExclProjection;
}

function getPaths(selector) {
  return Object.keys(new Minimongo.Matcher(selector)._paths); // XXX remove it?
  // return Object.keys(selector).map(k => {
  //   // we don't know how to handle $where because it can be anything
  //   if (k === '$where') {
  //     return ''; // matches everything
  //   }
  //   // we branch from $or/$and/$nor operator
  //   if (['$or', '$and', '$nor'].includes(k)) {
  //     return selector[k].map(getPaths);
  //   }
  //   // the value is a literal or some comparison operator
  //   return k;
  // })
  //   .reduce((a, b) => a.concat(b), [])
  //   .filter((a, b, c) => c.indexOf(a) === b);
} // A helper to ensure object has only certain keys


function onlyContainsKeys(obj, keys) {
  return Object.keys(obj).every(k => keys.includes(k));
}

function pathHasNumericKeys(path) {
  return path.split('.').some(isNumericKey);
} // Returns a set of key paths similar to
// { 'foo.bar': 1, 'a.b.c': 1 }


function treeToPaths(tree) {
  let prefix = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : '';
  const result = {};
  Object.keys(tree).forEach(key => {
    const value = tree[key];

    if (value === Object(value)) {
      Object.assign(result, treeToPaths(value, "".concat(prefix + key, ".")));
    } else {
      result[prefix + key] = value;
    }
  });
  return result;
}
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"common.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/minimongo/common.js                                                                                        //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
module.export({
  hasOwn: () => hasOwn,
  ELEMENT_OPERATORS: () => ELEMENT_OPERATORS,
  compileDocumentSelector: () => compileDocumentSelector,
  equalityElementMatcher: () => equalityElementMatcher,
  expandArraysInBranches: () => expandArraysInBranches,
  isIndexable: () => isIndexable,
  isNumericKey: () => isNumericKey,
  isOperatorObject: () => isOperatorObject,
  makeLookupFunction: () => makeLookupFunction,
  nothingMatcher: () => nothingMatcher,
  pathsToTree: () => pathsToTree,
  populateDocumentWithQueryFields: () => populateDocumentWithQueryFields,
  projectionDetails: () => projectionDetails,
  regexpElementMatcher: () => regexpElementMatcher
});
let LocalCollection;
module.link("./local_collection.js", {
  default(v) {
    LocalCollection = v;
  }

}, 0);
const hasOwn = Object.prototype.hasOwnProperty;
const ELEMENT_OPERATORS = {
  $lt: makeInequality(cmpValue => cmpValue < 0),
  $gt: makeInequality(cmpValue => cmpValue > 0),
  $lte: makeInequality(cmpValue => cmpValue <= 0),
  $gte: makeInequality(cmpValue => cmpValue >= 0),
  $mod: {
    compileElementSelector(operand) {
      if (!(Array.isArray(operand) && operand.length === 2 && typeof operand[0] === 'number' && typeof operand[1] === 'number')) {
        throw Error('argument to $mod must be an array of two numbers');
      } // XXX could require to be ints or round or something


      const divisor = operand[0];
      const remainder = operand[1];
      return value => typeof value === 'number' && value % divisor === remainder;
    }

  },
  $in: {
    compileElementSelector(operand) {
      if (!Array.isArray(operand)) {
        throw Error('$in needs an array');
      }

      const elementMatchers = operand.map(option => {
        if (option instanceof RegExp) {
          return regexpElementMatcher(option);
        }

        if (isOperatorObject(option)) {
          throw Error('cannot nest $ under $in');
        }

        return equalityElementMatcher(option);
      });
      return value => {
        // Allow {a: {$in: [null]}} to match when 'a' does not exist.
        if (value === undefined) {
          value = null;
        }

        return elementMatchers.some(matcher => matcher(value));
      };
    }

  },
  $size: {
    // {a: [[5, 5]]} must match {a: {$size: 1}} but not {a: {$size: 2}}, so we
    // don't want to consider the element [5,5] in the leaf array [[5,5]] as a
    // possible value.
    dontExpandLeafArrays: true,

    compileElementSelector(operand) {
      if (typeof operand === 'string') {
        // Don't ask me why, but by experimentation, this seems to be what Mongo
        // does.
        operand = 0;
      } else if (typeof operand !== 'number') {
        throw Error('$size needs a number');
      }

      return value => Array.isArray(value) && value.length === operand;
    }

  },
  $type: {
    // {a: [5]} must not match {a: {$type: 4}} (4 means array), but it should
    // match {a: {$type: 1}} (1 means number), and {a: [[5]]} must match {$a:
    // {$type: 4}}. Thus, when we see a leaf array, we *should* expand it but
    // should *not* include it itself.
    dontIncludeLeafArrays: true,

    compileElementSelector(operand) {
      if (typeof operand === 'string') {
        const operandAliasMap = {
          'double': 1,
          'string': 2,
          'object': 3,
          'array': 4,
          'binData': 5,
          'undefined': 6,
          'objectId': 7,
          'bool': 8,
          'date': 9,
          'null': 10,
          'regex': 11,
          'dbPointer': 12,
          'javascript': 13,
          'symbol': 14,
          'javascriptWithScope': 15,
          'int': 16,
          'timestamp': 17,
          'long': 18,
          'decimal': 19,
          'minKey': -1,
          'maxKey': 127
        };

        if (!hasOwn.call(operandAliasMap, operand)) {
          throw Error("unknown string alias for $type: ".concat(operand));
        }

        operand = operandAliasMap[operand];
      } else if (typeof operand === 'number') {
        if (operand === 0 || operand < -1 || operand > 19 && operand !== 127) {
          throw Error("Invalid numerical $type code: ".concat(operand));
        }
      } else {
        throw Error('argument to $type is not a number or a string');
      }

      return value => value !== undefined && LocalCollection._f._type(value) === operand;
    }

  },
  $bitsAllSet: {
    compileElementSelector(operand) {
      const mask = getOperandBitmask(operand, '$bitsAllSet');
      return value => {
        const bitmask = getValueBitmask(value, mask.length);
        return bitmask && mask.every((byte, i) => (bitmask[i] & byte) === byte);
      };
    }

  },
  $bitsAnySet: {
    compileElementSelector(operand) {
      const mask = getOperandBitmask(operand, '$bitsAnySet');
      return value => {
        const bitmask = getValueBitmask(value, mask.length);
        return bitmask && mask.some((byte, i) => (~bitmask[i] & byte) !== byte);
      };
    }

  },
  $bitsAllClear: {
    compileElementSelector(operand) {
      const mask = getOperandBitmask(operand, '$bitsAllClear');
      return value => {
        const bitmask = getValueBitmask(value, mask.length);
        return bitmask && mask.every((byte, i) => !(bitmask[i] & byte));
      };
    }

  },
  $bitsAnyClear: {
    compileElementSelector(operand) {
      const mask = getOperandBitmask(operand, '$bitsAnyClear');
      return value => {
        const bitmask = getValueBitmask(value, mask.length);
        return bitmask && mask.some((byte, i) => (bitmask[i] & byte) !== byte);
      };
    }

  },
  $regex: {
    compileElementSelector(operand, valueSelector) {
      if (!(typeof operand === 'string' || operand instanceof RegExp)) {
        throw Error('$regex has to be a string or RegExp');
      }

      let regexp;

      if (valueSelector.$options !== undefined) {
        // Options passed in $options (even the empty string) always overrides
        // options in the RegExp object itself.
        // Be clear that we only support the JS-supported options, not extended
        // ones (eg, Mongo supports x and s). Ideally we would implement x and s
        // by transforming the regexp, but not today...
        if (/[^gim]/.test(valueSelector.$options)) {
          throw new Error('Only the i, m, and g regexp options are supported');
        }

        const source = operand instanceof RegExp ? operand.source : operand;
        regexp = new RegExp(source, valueSelector.$options);
      } else if (operand instanceof RegExp) {
        regexp = operand;
      } else {
        regexp = new RegExp(operand);
      }

      return regexpElementMatcher(regexp);
    }

  },
  $elemMatch: {
    dontExpandLeafArrays: true,

    compileElementSelector(operand, valueSelector, matcher) {
      if (!LocalCollection._isPlainObject(operand)) {
        throw Error('$elemMatch need an object');
      }

      const isDocMatcher = !isOperatorObject(Object.keys(operand).filter(key => !hasOwn.call(LOGICAL_OPERATORS, key)).reduce((a, b) => Object.assign(a, {
        [b]: operand[b]
      }), {}), true);
      let subMatcher;

      if (isDocMatcher) {
        // This is NOT the same as compileValueSelector(operand), and not just
        // because of the slightly different calling convention.
        // {$elemMatch: {x: 3}} means "an element has a field x:3", not
        // "consists only of a field x:3". Also, regexps and sub-$ are allowed.
        subMatcher = compileDocumentSelector(operand, matcher, {
          inElemMatch: true
        });
      } else {
        subMatcher = compileValueSelector(operand, matcher);
      }

      return value => {
        if (!Array.isArray(value)) {
          return false;
        }

        for (let i = 0; i < value.length; ++i) {
          const arrayElement = value[i];
          let arg;

          if (isDocMatcher) {
            // We can only match {$elemMatch: {b: 3}} against objects.
            // (We can also match against arrays, if there's numeric indices,
            // eg {$elemMatch: {'0.b': 3}} or {$elemMatch: {0: 3}}.)
            if (!isIndexable(arrayElement)) {
              return false;
            }

            arg = arrayElement;
          } else {
            // dontIterate ensures that {a: {$elemMatch: {$gt: 5}}} matches
            // {a: [8]} but not {a: [[8]]}
            arg = [{
              value: arrayElement,
              dontIterate: true
            }];
          } // XXX support $near in $elemMatch by propagating $distance?


          if (subMatcher(arg).result) {
            return i; // specially understood to mean "use as arrayIndices"
          }
        }

        return false;
      };
    }

  }
};
// Operators that appear at the top level of a document selector.
const LOGICAL_OPERATORS = {
  $and(subSelector, matcher, inElemMatch) {
    return andDocumentMatchers(compileArrayOfDocumentSelectors(subSelector, matcher, inElemMatch));
  },

  $or(subSelector, matcher, inElemMatch) {
    const matchers = compileArrayOfDocumentSelectors(subSelector, matcher, inElemMatch); // Special case: if there is only one matcher, use it directly, *preserving*
    // any arrayIndices it returns.

    if (matchers.length === 1) {
      return matchers[0];
    }

    return doc => {
      const result = matchers.some(fn => fn(doc).result); // $or does NOT set arrayIndices when it has multiple
      // sub-expressions. (Tested against MongoDB.)

      return {
        result
      };
    };
  },

  $nor(subSelector, matcher, inElemMatch) {
    const matchers = compileArrayOfDocumentSelectors(subSelector, matcher, inElemMatch);
    return doc => {
      const result = matchers.every(fn => !fn(doc).result); // Never set arrayIndices, because we only match if nothing in particular
      // 'matched' (and because this is consistent with MongoDB).

      return {
        result
      };
    };
  },

  $where(selectorValue, matcher) {
    // Record that *any* path may be used.
    matcher._recordPathUsed('');

    matcher._hasWhere = true;

    if (!(selectorValue instanceof Function)) {
      // XXX MongoDB seems to have more complex logic to decide where or or not
      // to add 'return'; not sure exactly what it is.
      selectorValue = Function('obj', "return ".concat(selectorValue));
    } // We make the document available as both `this` and `obj`.
    // // XXX not sure what we should do if this throws


    return doc => ({
      result: selectorValue.call(doc, doc)
    });
  },

  // This is just used as a comment in the query (in MongoDB, it also ends up in
  // query logs); it has no effect on the actual selection.
  $comment() {
    return () => ({
      result: true
    });
  }

}; // Operators that (unlike LOGICAL_OPERATORS) pertain to individual paths in a
// document, but (unlike ELEMENT_OPERATORS) do not have a simple definition as
// "match each branched value independently and combine with
// convertElementMatcherToBranchedMatcher".

const VALUE_OPERATORS = {
  $eq(operand) {
    return convertElementMatcherToBranchedMatcher(equalityElementMatcher(operand));
  },

  $not(operand, valueSelector, matcher) {
    return invertBranchedMatcher(compileValueSelector(operand, matcher));
  },

  $ne(operand) {
    return invertBranchedMatcher(convertElementMatcherToBranchedMatcher(equalityElementMatcher(operand)));
  },

  $nin(operand) {
    return invertBranchedMatcher(convertElementMatcherToBranchedMatcher(ELEMENT_OPERATORS.$in.compileElementSelector(operand)));
  },

  $exists(operand) {
    const exists = convertElementMatcherToBranchedMatcher(value => value !== undefined);
    return operand ? exists : invertBranchedMatcher(exists);
  },

  // $options just provides options for $regex; its logic is inside $regex
  $options(operand, valueSelector) {
    if (!hasOwn.call(valueSelector, '$regex')) {
      throw Error('$options needs a $regex');
    }

    return everythingMatcher;
  },

  // $maxDistance is basically an argument to $near
  $maxDistance(operand, valueSelector) {
    if (!valueSelector.$near) {
      throw Error('$maxDistance needs a $near');
    }

    return everythingMatcher;
  },

  $all(operand, valueSelector, matcher) {
    if (!Array.isArray(operand)) {
      throw Error('$all requires array');
    } // Not sure why, but this seems to be what MongoDB does.


    if (operand.length === 0) {
      return nothingMatcher;
    }

    const branchedMatchers = operand.map(criterion => {
      // XXX handle $all/$elemMatch combination
      if (isOperatorObject(criterion)) {
        throw Error('no $ expressions in $all');
      } // This is always a regexp or equality selector.


      return compileValueSelector(criterion, matcher);
    }); // andBranchedMatchers does NOT require all selectors to return true on the
    // SAME branch.

    return andBranchedMatchers(branchedMatchers);
  },

  $near(operand, valueSelector, matcher, isRoot) {
    if (!isRoot) {
      throw Error('$near can\'t be inside another $ operator');
    }

    matcher._hasGeoQuery = true; // There are two kinds of geodata in MongoDB: legacy coordinate pairs and
    // GeoJSON. They use different distance metrics, too. GeoJSON queries are
    // marked with a $geometry property, though legacy coordinates can be
    // matched using $geometry.

    let maxDistance, point, distance;

    if (LocalCollection._isPlainObject(operand) && hasOwn.call(operand, '$geometry')) {
      // GeoJSON "2dsphere" mode.
      maxDistance = operand.$maxDistance;
      point = operand.$geometry;

      distance = value => {
        // XXX: for now, we don't calculate the actual distance between, say,
        // polygon and circle. If people care about this use-case it will get
        // a priority.
        if (!value) {
          return null;
        }

        if (!value.type) {
          return GeoJSON.pointDistance(point, {
            type: 'Point',
            coordinates: pointToArray(value)
          });
        }

        if (value.type === 'Point') {
          return GeoJSON.pointDistance(point, value);
        }

        return GeoJSON.geometryWithinRadius(value, point, maxDistance) ? 0 : maxDistance + 1;
      };
    } else {
      maxDistance = valueSelector.$maxDistance;

      if (!isIndexable(operand)) {
        throw Error('$near argument must be coordinate pair or GeoJSON');
      }

      point = pointToArray(operand);

      distance = value => {
        if (!isIndexable(value)) {
          return null;
        }

        return distanceCoordinatePairs(point, value);
      };
    }

    return branchedValues => {
      // There might be multiple points in the document that match the given
      // field. Only one of them needs to be within $maxDistance, but we need to
      // evaluate all of them and use the nearest one for the implicit sort
      // specifier. (That's why we can't just use ELEMENT_OPERATORS here.)
      //
      // Note: This differs from MongoDB's implementation, where a document will
      // actually show up *multiple times* in the result set, with one entry for
      // each within-$maxDistance branching point.
      const result = {
        result: false
      };
      expandArraysInBranches(branchedValues).every(branch => {
        // if operation is an update, don't skip branches, just return the first
        // one (#3599)
        let curDistance;

        if (!matcher._isUpdate) {
          if (!(typeof branch.value === 'object')) {
            return true;
          }

          curDistance = distance(branch.value); // Skip branches that aren't real points or are too far away.

          if (curDistance === null || curDistance > maxDistance) {
            return true;
          } // Skip anything that's a tie.


          if (result.distance !== undefined && result.distance <= curDistance) {
            return true;
          }
        }

        result.result = true;
        result.distance = curDistance;

        if (branch.arrayIndices) {
          result.arrayIndices = branch.arrayIndices;
        } else {
          delete result.arrayIndices;
        }

        return !matcher._isUpdate;
      });
      return result;
    };
  }

}; // NB: We are cheating and using this function to implement 'AND' for both
// 'document matchers' and 'branched matchers'. They both return result objects
// but the argument is different: for the former it's a whole doc, whereas for
// the latter it's an array of 'branched values'.

function andSomeMatchers(subMatchers) {
  if (subMatchers.length === 0) {
    return everythingMatcher;
  }

  if (subMatchers.length === 1) {
    return subMatchers[0];
  }

  return docOrBranches => {
    const match = {};
    match.result = subMatchers.every(fn => {
      const subResult = fn(docOrBranches); // Copy a 'distance' number out of the first sub-matcher that has
      // one. Yes, this means that if there are multiple $near fields in a
      // query, something arbitrary happens; this appears to be consistent with
      // Mongo.

      if (subResult.result && subResult.distance !== undefined && match.distance === undefined) {
        match.distance = subResult.distance;
      } // Similarly, propagate arrayIndices from sub-matchers... but to match
      // MongoDB behavior, this time the *last* sub-matcher with arrayIndices
      // wins.


      if (subResult.result && subResult.arrayIndices) {
        match.arrayIndices = subResult.arrayIndices;
      }

      return subResult.result;
    }); // If we didn't actually match, forget any extra metadata we came up with.

    if (!match.result) {
      delete match.distance;
      delete match.arrayIndices;
    }

    return match;
  };
}

const andDocumentMatchers = andSomeMatchers;
const andBranchedMatchers = andSomeMatchers;

function compileArrayOfDocumentSelectors(selectors, matcher, inElemMatch) {
  if (!Array.isArray(selectors) || selectors.length === 0) {
    throw Error('$and/$or/$nor must be nonempty array');
  }

  return selectors.map(subSelector => {
    if (!LocalCollection._isPlainObject(subSelector)) {
      throw Error('$or/$and/$nor entries need to be full objects');
    }

    return compileDocumentSelector(subSelector, matcher, {
      inElemMatch
    });
  });
} // Takes in a selector that could match a full document (eg, the original
// selector). Returns a function mapping document->result object.
//
// matcher is the Matcher object we are compiling.
//
// If this is the root document selector (ie, not wrapped in $and or the like),
// then isRoot is true. (This is used by $near.)


function compileDocumentSelector(docSelector, matcher) {
  let options = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};
  const docMatchers = Object.keys(docSelector).map(key => {
    const subSelector = docSelector[key];

    if (key.substr(0, 1) === '$') {
      // Outer operators are either logical operators (they recurse back into
      // this function), or $where.
      if (!hasOwn.call(LOGICAL_OPERATORS, key)) {
        throw new Error("Unrecognized logical operator: ".concat(key));
      }

      matcher._isSimple = false;
      return LOGICAL_OPERATORS[key](subSelector, matcher, options.inElemMatch);
    } // Record this path, but only if we aren't in an elemMatcher, since in an
    // elemMatch this is a path inside an object in an array, not in the doc
    // root.


    if (!options.inElemMatch) {
      matcher._recordPathUsed(key);
    } // Don't add a matcher if subSelector is a function -- this is to match
    // the behavior of Meteor on the server (inherited from the node mongodb
    // driver), which is to ignore any part of a selector which is a function.


    if (typeof subSelector === 'function') {
      return undefined;
    }

    const lookUpByIndex = makeLookupFunction(key);
    const valueMatcher = compileValueSelector(subSelector, matcher, options.isRoot);
    return doc => valueMatcher(lookUpByIndex(doc));
  }).filter(Boolean);
  return andDocumentMatchers(docMatchers);
}

// Takes in a selector that could match a key-indexed value in a document; eg,
// {$gt: 5, $lt: 9}, or a regular expression, or any non-expression object (to
// indicate equality).  Returns a branched matcher: a function mapping
// [branched value]->result object.
function compileValueSelector(valueSelector, matcher, isRoot) {
  if (valueSelector instanceof RegExp) {
    matcher._isSimple = false;
    return convertElementMatcherToBranchedMatcher(regexpElementMatcher(valueSelector));
  }

  if (isOperatorObject(valueSelector)) {
    return operatorBranchedMatcher(valueSelector, matcher, isRoot);
  }

  return convertElementMatcherToBranchedMatcher(equalityElementMatcher(valueSelector));
} // Given an element matcher (which evaluates a single value), returns a branched
// value (which evaluates the element matcher on all the branches and returns a
// more structured return value possibly including arrayIndices).


function convertElementMatcherToBranchedMatcher(elementMatcher) {
  let options = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};
  return branches => {
    const expanded = options.dontExpandLeafArrays ? branches : expandArraysInBranches(branches, options.dontIncludeLeafArrays);
    const match = {};
    match.result = expanded.some(element => {
      let matched = elementMatcher(element.value); // Special case for $elemMatch: it means "true, and use this as an array
      // index if I didn't already have one".

      if (typeof matched === 'number') {
        // XXX This code dates from when we only stored a single array index
        // (for the outermost array). Should we be also including deeper array
        // indices from the $elemMatch match?
        if (!element.arrayIndices) {
          element.arrayIndices = [matched];
        }

        matched = true;
      } // If some element matched, and it's tagged with array indices, include
      // those indices in our result object.


      if (matched && element.arrayIndices) {
        match.arrayIndices = element.arrayIndices;
      }

      return matched;
    });
    return match;
  };
} // Helpers for $near.


function distanceCoordinatePairs(a, b) {
  const pointA = pointToArray(a);
  const pointB = pointToArray(b);
  return Math.hypot(pointA[0] - pointB[0], pointA[1] - pointB[1]);
} // Takes something that is not an operator object and returns an element matcher
// for equality with that thing.


function equalityElementMatcher(elementSelector) {
  if (isOperatorObject(elementSelector)) {
    throw Error('Can\'t create equalityValueSelector for operator object');
  } // Special-case: null and undefined are equal (if you got undefined in there
  // somewhere, or if you got it due to some branch being non-existent in the
  // weird special case), even though they aren't with EJSON.equals.
  // undefined or null


  if (elementSelector == null) {
    return value => value == null;
  }

  return value => LocalCollection._f._equal(elementSelector, value);
}

function everythingMatcher(docOrBranchedValues) {
  return {
    result: true
  };
}

function expandArraysInBranches(branches, skipTheArrays) {
  const branchesOut = [];
  branches.forEach(branch => {
    const thisIsArray = Array.isArray(branch.value); // We include the branch itself, *UNLESS* we it's an array that we're going
    // to iterate and we're told to skip arrays.  (That's right, we include some
    // arrays even skipTheArrays is true: these are arrays that were found via
    // explicit numerical indices.)

    if (!(skipTheArrays && thisIsArray && !branch.dontIterate)) {
      branchesOut.push({
        arrayIndices: branch.arrayIndices,
        value: branch.value
      });
    }

    if (thisIsArray && !branch.dontIterate) {
      branch.value.forEach((value, i) => {
        branchesOut.push({
          arrayIndices: (branch.arrayIndices || []).concat(i),
          value
        });
      });
    }
  });
  return branchesOut;
}

// Helpers for $bitsAllSet/$bitsAnySet/$bitsAllClear/$bitsAnyClear.
function getOperandBitmask(operand, selector) {
  // numeric bitmask
  // You can provide a numeric bitmask to be matched against the operand field.
  // It must be representable as a non-negative 32-bit signed integer.
  // Otherwise, $bitsAllSet will return an error.
  if (Number.isInteger(operand) && operand >= 0) {
    return new Uint8Array(new Int32Array([operand]).buffer);
  } // bindata bitmask
  // You can also use an arbitrarily large BinData instance as a bitmask.


  if (EJSON.isBinary(operand)) {
    return new Uint8Array(operand.buffer);
  } // position list
  // If querying a list of bit positions, each <position> must be a non-negative
  // integer. Bit positions start at 0 from the least significant bit.


  if (Array.isArray(operand) && operand.every(x => Number.isInteger(x) && x >= 0)) {
    const buffer = new ArrayBuffer((Math.max(...operand) >> 3) + 1);
    const view = new Uint8Array(buffer);
    operand.forEach(x => {
      view[x >> 3] |= 1 << (x & 0x7);
    });
    return view;
  } // bad operand


  throw Error("operand to ".concat(selector, " must be a numeric bitmask (representable as a ") + 'non-negative 32-bit signed integer), a bindata bitmask or an array with ' + 'bit positions (non-negative integers)');
}

function getValueBitmask(value, length) {
  // The field value must be either numerical or a BinData instance. Otherwise,
  // $bits... will not match the current document.
  // numerical
  if (Number.isSafeInteger(value)) {
    // $bits... will not match numerical values that cannot be represented as a
    // signed 64-bit integer. This can be the case if a value is either too
    // large or small to fit in a signed 64-bit integer, or if it has a
    // fractional component.
    const buffer = new ArrayBuffer(Math.max(length, 2 * Uint32Array.BYTES_PER_ELEMENT));
    let view = new Uint32Array(buffer, 0, 2);
    view[0] = value % ((1 << 16) * (1 << 16)) | 0;
    view[1] = value / ((1 << 16) * (1 << 16)) | 0; // sign extension

    if (value < 0) {
      view = new Uint8Array(buffer, 2);
      view.forEach((byte, i) => {
        view[i] = 0xff;
      });
    }

    return new Uint8Array(buffer);
  } // bindata


  if (EJSON.isBinary(value)) {
    return new Uint8Array(value.buffer);
  } // no match


  return false;
} // Actually inserts a key value into the selector document
// However, this checks there is no ambiguity in setting
// the value for the given key, throws otherwise


function insertIntoDocument(document, key, value) {
  Object.keys(document).forEach(existingKey => {
    if (existingKey.length > key.length && existingKey.indexOf("".concat(key, ".")) === 0 || key.length > existingKey.length && key.indexOf("".concat(existingKey, ".")) === 0) {
      throw new Error("cannot infer query fields to set, both paths '".concat(existingKey, "' and ") + "'".concat(key, "' are matched"));
    } else if (existingKey === key) {
      throw new Error("cannot infer query fields to set, path '".concat(key, "' is matched twice"));
    }
  });
  document[key] = value;
} // Returns a branched matcher that matches iff the given matcher does not.
// Note that this implicitly "deMorganizes" the wrapped function.  ie, it
// means that ALL branch values need to fail to match innerBranchedMatcher.


function invertBranchedMatcher(branchedMatcher) {
  return branchValues => {
    // We explicitly choose to strip arrayIndices here: it doesn't make sense to
    // say "update the array element that does not match something", at least
    // in mongo-land.
    return {
      result: !branchedMatcher(branchValues).result
    };
  };
}

function isIndexable(obj) {
  return Array.isArray(obj) || LocalCollection._isPlainObject(obj);
}

function isNumericKey(s) {
  return /^[0-9]+$/.test(s);
}

function isOperatorObject(valueSelector, inconsistentOK) {
  if (!LocalCollection._isPlainObject(valueSelector)) {
    return false;
  }

  let theseAreOperators = undefined;
  Object.keys(valueSelector).forEach(selKey => {
    const thisIsOperator = selKey.substr(0, 1) === '$' || selKey === 'diff';

    if (theseAreOperators === undefined) {
      theseAreOperators = thisIsOperator;
    } else if (theseAreOperators !== thisIsOperator) {
      if (!inconsistentOK) {
        throw new Error("Inconsistent operator: ".concat(JSON.stringify(valueSelector)));
      }

      theseAreOperators = false;
    }
  });
  return !!theseAreOperators; // {} has no operators
}

// Helper for $lt/$gt/$lte/$gte.
function makeInequality(cmpValueComparator) {
  return {
    compileElementSelector(operand) {
      // Arrays never compare false with non-arrays for any inequality.
      // XXX This was behavior we observed in pre-release MongoDB 2.5, but
      //     it seems to have been reverted.
      //     See https://jira.mongodb.org/browse/SERVER-11444
      if (Array.isArray(operand)) {
        return () => false;
      } // Special case: consider undefined and null the same (so true with
      // $gte/$lte).


      if (operand === undefined) {
        operand = null;
      }

      const operandType = LocalCollection._f._type(operand);

      return value => {
        if (value === undefined) {
          value = null;
        } // Comparisons are never true among things of different type (except
        // null vs undefined).


        if (LocalCollection._f._type(value) !== operandType) {
          return false;
        }

        return cmpValueComparator(LocalCollection._f._cmp(value, operand));
      };
    }

  };
} // makeLookupFunction(key) returns a lookup function.
//
// A lookup function takes in a document and returns an array of matching
// branches.  If no arrays are found while looking up the key, this array will
// have exactly one branches (possibly 'undefined', if some segment of the key
// was not found).
//
// If arrays are found in the middle, this can have more than one element, since
// we 'branch'. When we 'branch', if there are more key segments to look up,
// then we only pursue branches that are plain objects (not arrays or scalars).
// This means we can actually end up with no branches!
//
// We do *NOT* branch on arrays that are found at the end (ie, at the last
// dotted member of the key). We just return that array; if you want to
// effectively 'branch' over the array's values, post-process the lookup
// function with expandArraysInBranches.
//
// Each branch is an object with keys:
//  - value: the value at the branch
//  - dontIterate: an optional bool; if true, it means that 'value' is an array
//    that expandArraysInBranches should NOT expand. This specifically happens
//    when there is a numeric index in the key, and ensures the
//    perhaps-surprising MongoDB behavior where {'a.0': 5} does NOT
//    match {a: [[5]]}.
//  - arrayIndices: if any array indexing was done during lookup (either due to
//    explicit numeric indices or implicit branching), this will be an array of
//    the array indices used, from outermost to innermost; it is falsey or
//    absent if no array index is used. If an explicit numeric index is used,
//    the index will be followed in arrayIndices by the string 'x'.
//
//    Note: arrayIndices is used for two purposes. First, it is used to
//    implement the '$' modifier feature, which only ever looks at its first
//    element.
//
//    Second, it is used for sort key generation, which needs to be able to tell
//    the difference between different paths. Moreover, it needs to
//    differentiate between explicit and implicit branching, which is why
//    there's the somewhat hacky 'x' entry: this means that explicit and
//    implicit array lookups will have different full arrayIndices paths. (That
//    code only requires that different paths have different arrayIndices; it
//    doesn't actually 'parse' arrayIndices. As an alternative, arrayIndices
//    could contain objects with flags like 'implicit', but I think that only
//    makes the code surrounding them more complex.)
//
//    (By the way, this field ends up getting passed around a lot without
//    cloning, so never mutate any arrayIndices field/var in this package!)
//
//
// At the top level, you may only pass in a plain object or array.
//
// See the test 'minimongo - lookup' for some examples of what lookup functions
// return.


function makeLookupFunction(key) {
  let options = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};
  const parts = key.split('.');
  const firstPart = parts.length ? parts[0] : '';
  const lookupRest = parts.length > 1 && makeLookupFunction(parts.slice(1).join('.'), options);

  const omitUnnecessaryFields = result => {
    if (!result.dontIterate) {
      delete result.dontIterate;
    }

    if (result.arrayIndices && !result.arrayIndices.length) {
      delete result.arrayIndices;
    }

    return result;
  }; // Doc will always be a plain object or an array.
  // apply an explicit numeric index, an array.


  return function (doc) {
    let arrayIndices = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : [];

    if (Array.isArray(doc)) {
      // If we're being asked to do an invalid lookup into an array (non-integer
      // or out-of-bounds), return no results (which is different from returning
      // a single undefined result, in that `null` equality checks won't match).
      if (!(isNumericKey(firstPart) && firstPart < doc.length)) {
        return [];
      } // Remember that we used this array index. Include an 'x' to indicate that
      // the previous index came from being considered as an explicit array
      // index (not branching).


      arrayIndices = arrayIndices.concat(+firstPart, 'x');
    } // Do our first lookup.


    const firstLevel = doc[firstPart]; // If there is no deeper to dig, return what we found.
    //
    // If what we found is an array, most value selectors will choose to treat
    // the elements of the array as matchable values in their own right, but
    // that's done outside of the lookup function. (Exceptions to this are $size
    // and stuff relating to $elemMatch.  eg, {a: {$size: 2}} does not match {a:
    // [[1, 2]]}.)
    //
    // That said, if we just did an *explicit* array lookup (on doc) to find
    // firstLevel, and firstLevel is an array too, we do NOT want value
    // selectors to iterate over it.  eg, {'a.0': 5} does not match {a: [[5]]}.
    // So in that case, we mark the return value as 'don't iterate'.

    if (!lookupRest) {
      return [omitUnnecessaryFields({
        arrayIndices,
        dontIterate: Array.isArray(doc) && Array.isArray(firstLevel),
        value: firstLevel
      })];
    } // We need to dig deeper.  But if we can't, because what we've found is not
    // an array or plain object, we're done. If we just did a numeric index into
    // an array, we return nothing here (this is a change in Mongo 2.5 from
    // Mongo 2.4, where {'a.0.b': null} stopped matching {a: [5]}). Otherwise,
    // return a single `undefined` (which can, for example, match via equality
    // with `null`).


    if (!isIndexable(firstLevel)) {
      if (Array.isArray(doc)) {
        return [];
      }

      return [omitUnnecessaryFields({
        arrayIndices,
        value: undefined
      })];
    }

    const result = [];

    const appendToResult = more => {
      result.push(...more);
    }; // Dig deeper: look up the rest of the parts on whatever we've found.
    // (lookupRest is smart enough to not try to do invalid lookups into
    // firstLevel if it's an array.)


    appendToResult(lookupRest(firstLevel, arrayIndices)); // If we found an array, then in *addition* to potentially treating the next
    // part as a literal integer lookup, we should also 'branch': try to look up
    // the rest of the parts on each array element in parallel.
    //
    // In this case, we *only* dig deeper into array elements that are plain
    // objects. (Recall that we only got this far if we have further to dig.)
    // This makes sense: we certainly don't dig deeper into non-indexable
    // objects. And it would be weird to dig into an array: it's simpler to have
    // a rule that explicit integer indexes only apply to an outer array, not to
    // an array you find after a branching search.
    //
    // In the special case of a numeric part in a *sort selector* (not a query
    // selector), we skip the branching: we ONLY allow the numeric part to mean
    // 'look up this index' in that case, not 'also look up this index in all
    // the elements of the array'.

    if (Array.isArray(firstLevel) && !(isNumericKey(parts[1]) && options.forSort)) {
      firstLevel.forEach((branch, arrayIndex) => {
        if (LocalCollection._isPlainObject(branch)) {
          appendToResult(lookupRest(branch, arrayIndices.concat(arrayIndex)));
        }
      });
    }

    return result;
  };
}

// Object exported only for unit testing.
// Use it to export private functions to test in Tinytest.
MinimongoTest = {
  makeLookupFunction
};

MinimongoError = function (message) {
  let options = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};

  if (typeof message === 'string' && options.field) {
    message += " for field '".concat(options.field, "'");
  }

  const error = new Error(message);
  error.name = 'MinimongoError';
  return error;
};

function nothingMatcher(docOrBranchedValues) {
  return {
    result: false
  };
}

// Takes an operator object (an object with $ keys) and returns a branched
// matcher for it.
function operatorBranchedMatcher(valueSelector, matcher, isRoot) {
  // Each valueSelector works separately on the various branches.  So one
  // operator can match one branch and another can match another branch.  This
  // is OK.
  const operatorMatchers = Object.keys(valueSelector).map(operator => {
    const operand = valueSelector[operator];
    const simpleRange = ['$lt', '$lte', '$gt', '$gte'].includes(operator) && typeof operand === 'number';
    const simpleEquality = ['$ne', '$eq'].includes(operator) && operand !== Object(operand);
    const simpleInclusion = ['$in', '$nin'].includes(operator) && Array.isArray(operand) && !operand.some(x => x === Object(x));

    if (!(simpleRange || simpleInclusion || simpleEquality)) {
      matcher._isSimple = false;
    }

    if (hasOwn.call(VALUE_OPERATORS, operator)) {
      return VALUE_OPERATORS[operator](operand, valueSelector, matcher, isRoot);
    }

    if (hasOwn.call(ELEMENT_OPERATORS, operator)) {
      const options = ELEMENT_OPERATORS[operator];
      return convertElementMatcherToBranchedMatcher(options.compileElementSelector(operand, valueSelector, matcher), options);
    }

    throw new Error("Unrecognized operator: ".concat(operator));
  });
  return andBranchedMatchers(operatorMatchers);
} // paths - Array: list of mongo style paths
// newLeafFn - Function: of form function(path) should return a scalar value to
//                       put into list created for that path
// conflictFn - Function: of form function(node, path, fullPath) is called
//                        when building a tree path for 'fullPath' node on
//                        'path' was already a leaf with a value. Must return a
//                        conflict resolution.
// initial tree - Optional Object: starting tree.
// @returns - Object: tree represented as a set of nested objects


function pathsToTree(paths, newLeafFn, conflictFn) {
  let root = arguments.length > 3 && arguments[3] !== undefined ? arguments[3] : {};
  paths.forEach(path => {
    const pathArray = path.split('.');
    let tree = root; // use .every just for iteration with break

    const success = pathArray.slice(0, -1).every((key, i) => {
      if (!hasOwn.call(tree, key)) {
        tree[key] = {};
      } else if (tree[key] !== Object(tree[key])) {
        tree[key] = conflictFn(tree[key], pathArray.slice(0, i + 1).join('.'), path); // break out of loop if we are failing for this path

        if (tree[key] !== Object(tree[key])) {
          return false;
        }
      }

      tree = tree[key];
      return true;
    });

    if (success) {
      const lastKey = pathArray[pathArray.length - 1];

      if (hasOwn.call(tree, lastKey)) {
        tree[lastKey] = conflictFn(tree[lastKey], path, path);
      } else {
        tree[lastKey] = newLeafFn(path);
      }
    }
  });
  return root;
}

// Makes sure we get 2 elements array and assume the first one to be x and
// the second one to y no matter what user passes.
// In case user passes { lon: x, lat: y } returns [x, y]
function pointToArray(point) {
  return Array.isArray(point) ? point.slice() : [point.x, point.y];
} // Creating a document from an upsert is quite tricky.
// E.g. this selector: {"$or": [{"b.foo": {"$all": ["bar"]}}]}, should result
// in: {"b.foo": "bar"}
// But this selector: {"$or": [{"b": {"foo": {"$all": ["bar"]}}}]} should throw
// an error
// Some rules (found mainly with trial & error, so there might be more):
// - handle all childs of $and (or implicit $and)
// - handle $or nodes with exactly 1 child
// - ignore $or nodes with more than 1 child
// - ignore $nor and $not nodes
// - throw when a value can not be set unambiguously
// - every value for $all should be dealt with as separate $eq-s
// - threat all children of $all as $eq setters (=> set if $all.length === 1,
//   otherwise throw error)
// - you can not mix '$'-prefixed keys and non-'$'-prefixed keys
// - you can only have dotted keys on a root-level
// - you can not have '$'-prefixed keys more than one-level deep in an object
// Handles one key/value pair to put in the selector document


function populateDocumentWithKeyValue(document, key, value) {
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    populateDocumentWithObject(document, key, value);
  } else if (!(value instanceof RegExp)) {
    insertIntoDocument(document, key, value);
  }
} // Handles a key, value pair to put in the selector document
// if the value is an object


function populateDocumentWithObject(document, key, value) {
  const keys = Object.keys(value);
  const unprefixedKeys = keys.filter(op => op[0] !== '$');

  if (unprefixedKeys.length > 0 || !keys.length) {
    // Literal (possibly empty) object ( or empty object )
    // Don't allow mixing '$'-prefixed with non-'$'-prefixed fields
    if (keys.length !== unprefixedKeys.length) {
      throw new Error("unknown operator: ".concat(unprefixedKeys[0]));
    }

    validateObject(value, key);
    insertIntoDocument(document, key, value);
  } else {
    Object.keys(value).forEach(op => {
      const object = value[op];

      if (op === '$eq') {
        populateDocumentWithKeyValue(document, key, object);
      } else if (op === '$all') {
        // every value for $all should be dealt with as separate $eq-s
        object.forEach(element => populateDocumentWithKeyValue(document, key, element));
      }
    });
  }
} // Fills a document with certain fields from an upsert selector


function populateDocumentWithQueryFields(query) {
  let document = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};

  if (Object.getPrototypeOf(query) === Object.prototype) {
    // handle implicit $and
    Object.keys(query).forEach(key => {
      const value = query[key];

      if (key === '$and') {
        // handle explicit $and
        value.forEach(element => populateDocumentWithQueryFields(element, document));
      } else if (key === '$or') {
        // handle $or nodes with exactly 1 child
        if (value.length === 1) {
          populateDocumentWithQueryFields(value[0], document);
        }
      } else if (key[0] !== '$') {
        // Ignore other '$'-prefixed logical selectors
        populateDocumentWithKeyValue(document, key, value);
      }
    });
  } else {
    // Handle meteor-specific shortcut for selecting _id
    if (LocalCollection._selectorIsId(query)) {
      insertIntoDocument(document, '_id', query);
    }
  }

  return document;
}

function projectionDetails(fields) {
  // Find the non-_id keys (_id is handled specially because it is included
  // unless explicitly excluded). Sort the keys, so that our code to detect
  // overlaps like 'foo' and 'foo.bar' can assume that 'foo' comes first.
  let fieldsKeys = Object.keys(fields).sort(); // If _id is the only field in the projection, do not remove it, since it is
  // required to determine if this is an exclusion or exclusion. Also keep an
  // inclusive _id, since inclusive _id follows the normal rules about mixing
  // inclusive and exclusive fields. If _id is not the only field in the
  // projection and is exclusive, remove it so it can be handled later by a
  // special case, since exclusive _id is always allowed.

  if (!(fieldsKeys.length === 1 && fieldsKeys[0] === '_id') && !(fieldsKeys.includes('_id') && fields._id)) {
    fieldsKeys = fieldsKeys.filter(key => key !== '_id');
  }

  let including = null; // Unknown

  fieldsKeys.forEach(keyPath => {
    const rule = !!fields[keyPath];

    if (including === null) {
      including = rule;
    } // This error message is copied from MongoDB shell


    if (including !== rule) {
      throw MinimongoError('You cannot currently mix including and excluding fields.');
    }
  });
  const projectionRulesTree = pathsToTree(fieldsKeys, path => including, (node, path, fullPath) => {
    // Check passed projection fields' keys: If you have two rules such as
    // 'foo.bar' and 'foo.bar.baz', then the result becomes ambiguous. If
    // that happens, there is a probability you are doing something wrong,
    // framework should notify you about such mistake earlier on cursor
    // compilation step than later during runtime.  Note, that real mongo
    // doesn't do anything about it and the later rule appears in projection
    // project, more priority it takes.
    //
    // Example, assume following in mongo shell:
    // > db.coll.insert({ a: { b: 23, c: 44 } })
    // > db.coll.find({}, { 'a': 1, 'a.b': 1 })
    // {"_id": ObjectId("520bfe456024608e8ef24af3"), "a": {"b": 23}}
    // > db.coll.find({}, { 'a.b': 1, 'a': 1 })
    // {"_id": ObjectId("520bfe456024608e8ef24af3"), "a": {"b": 23, "c": 44}}
    //
    // Note, how second time the return set of keys is different.
    const currentPath = fullPath;
    const anotherPath = path;
    throw MinimongoError("both ".concat(currentPath, " and ").concat(anotherPath, " found in fields option, ") + 'using both of them may trigger unexpected behavior. Did you mean to ' + 'use only one of them?');
  });
  return {
    including,
    tree: projectionRulesTree
  };
}

function regexpElementMatcher(regexp) {
  return value => {
    if (value instanceof RegExp) {
      return value.toString() === regexp.toString();
    } // Regexps only work against strings.


    if (typeof value !== 'string') {
      return false;
    } // Reset regexp's state to avoid inconsistent matching for objects with the
    // same value on consecutive calls of regexp.test. This happens only if the
    // regexp has the 'g' flag. Also note that ES6 introduces a new flag 'y' for
    // which we should *not* change the lastIndex but MongoDB doesn't support
    // either of these flags.


    regexp.lastIndex = 0;
    return regexp.test(value);
  };
}

// Validates the key in a path.
// Objects that are nested more then 1 level cannot have dotted fields
// or fields starting with '$'
function validateKeyInPath(key, path) {
  if (key.includes('.')) {
    throw new Error("The dotted field '".concat(key, "' in '").concat(path, ".").concat(key, " is not valid for storage."));
  }

  if (key[0] === '$') {
    throw new Error("The dollar ($) prefixed field  '".concat(path, ".").concat(key, " is not valid for storage."));
  }
} // Recursively validates an object that is nested more than one level deep


function validateObject(object, path) {
  if (object && Object.getPrototypeOf(object) === Object.prototype) {
    Object.keys(object).forEach(key => {
      validateKeyInPath(key, path);
      validateObject(object[key], path + '.' + key);
    });
  }
}
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"constants.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/minimongo/constants.js                                                                                     //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
module.export({
  getAsyncMethodName: () => getAsyncMethodName,
  ASYNC_COLLECTION_METHODS: () => ASYNC_COLLECTION_METHODS,
  ASYNC_CURSOR_METHODS: () => ASYNC_CURSOR_METHODS
});

function getAsyncMethodName(method) {
  return "".concat(method.replace('_', ''), "Async");
}

const ASYNC_COLLECTION_METHODS = ['_createCappedCollection', '_dropCollection', '_dropIndex', 'createIndex', 'findOne', 'insert', 'remove', 'update', 'upsert'];
const ASYNC_CURSOR_METHODS = ['count', 'fetch', 'forEach', 'map'];
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"cursor.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/minimongo/cursor.js                                                                                        //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
module.export({
  default: () => Cursor
});
let LocalCollection;
module.link("./local_collection.js", {
  default(v) {
    LocalCollection = v;
  }

}, 0);
let hasOwn;
module.link("./common.js", {
  hasOwn(v) {
    hasOwn = v;
  }

}, 1);
let ASYNC_CURSOR_METHODS, getAsyncMethodName;
module.link("./constants", {
  ASYNC_CURSOR_METHODS(v) {
    ASYNC_CURSOR_METHODS = v;
  },

  getAsyncMethodName(v) {
    getAsyncMethodName = v;
  }

}, 2);

class Cursor {
  // don't call this ctor directly.  use LocalCollection.find().
  constructor(collection, selector) {
    let options = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};
    this.collection = collection;
    this.sorter = null;
    this.matcher = new Minimongo.Matcher(selector);

    if (LocalCollection._selectorIsIdPerhapsAsObject(selector)) {
      // stash for fast _id and { _id }
      this._selectorId = hasOwn.call(selector, '_id') ? selector._id : selector;
    } else {
      this._selectorId = undefined;

      if (this.matcher.hasGeoQuery() || options.sort) {
        this.sorter = new Minimongo.Sorter(options.sort || []);
      }
    }

    this.skip = options.skip || 0;
    this.limit = options.limit;
    this.fields = options.projection || options.fields;
    this._projectionFn = LocalCollection._compileProjection(this.fields || {});
    this._transform = LocalCollection.wrapTransform(options.transform); // by default, queries register w/ Tracker when it is available.

    if (typeof Tracker !== 'undefined') {
      this.reactive = options.reactive === undefined ? true : options.reactive;
    }
  }
  /**
   * @summary Returns the number of documents that match a query.
   * @memberOf Mongo.Cursor
   * @method  count
   * @instance
   * @locus Anywhere
   * @returns {Number}
   */


  count() {
    if (this.reactive) {
      // allow the observe to be unordered
      this._depend({
        added: true,
        removed: true
      }, true);
    }

    return this._getRawObjects({
      ordered: true
    }).length;
  }
  /**
   * @summary Return all matching documents as an Array.
   * @memberOf Mongo.Cursor
   * @method  fetch
   * @instance
   * @locus Anywhere
   * @returns {Object[]}
   */


  fetch() {
    const result = [];
    this.forEach(doc => {
      result.push(doc);
    });
    return result;
  }

  [Symbol.iterator]() {
    if (this.reactive) {
      this._depend({
        addedBefore: true,
        removed: true,
        changed: true,
        movedBefore: true
      });
    }

    let index = 0;

    const objects = this._getRawObjects({
      ordered: true
    });

    return {
      next: () => {
        if (index < objects.length) {
          // This doubles as a clone operation.
          let element = this._projectionFn(objects[index++]);

          if (this._transform) element = this._transform(element);
          return {
            value: element
          };
        }

        return {
          done: true
        };
      }
    };
  }

  [Symbol.asyncIterator]() {
    const syncResult = this[Symbol.iterator]();
    return {
      next() {
        return Promise.asyncApply(() => {
          return Promise.resolve(syncResult.next());
        });
      }

    };
  }
  /**
   * @callback IterationCallback
   * @param {Object} doc
   * @param {Number} index
   */

  /**
   * @summary Call `callback` once for each matching document, sequentially and
   *          synchronously.
   * @locus Anywhere
   * @method  forEach
   * @instance
   * @memberOf Mongo.Cursor
   * @param {IterationCallback} callback Function to call. It will be called
   *                                     with three arguments: the document, a
   *                                     0-based index, and <em>cursor</em>
   *                                     itself.
   * @param {Any} [thisArg] An object which will be the value of `this` inside
   *                        `callback`.
   */


  forEach(callback, thisArg) {
    if (this.reactive) {
      this._depend({
        addedBefore: true,
        removed: true,
        changed: true,
        movedBefore: true
      });
    }

    this._getRawObjects({
      ordered: true
    }).forEach((element, i) => {
      // This doubles as a clone operation.
      element = this._projectionFn(element);

      if (this._transform) {
        element = this._transform(element);
      }

      callback.call(thisArg, element, i, this);
    });
  }

  getTransform() {
    return this._transform;
  }
  /**
   * @summary Map callback over all matching documents.  Returns an Array.
   * @locus Anywhere
   * @method map
   * @instance
   * @memberOf Mongo.Cursor
   * @param {IterationCallback} callback Function to call. It will be called
   *                                     with three arguments: the document, a
   *                                     0-based index, and <em>cursor</em>
   *                                     itself.
   * @param {Any} [thisArg] An object which will be the value of `this` inside
   *                        `callback`.
   */


  map(callback, thisArg) {
    const result = [];
    this.forEach((doc, i) => {
      result.push(callback.call(thisArg, doc, i, this));
    });
    return result;
  } // options to contain:
  //  * callbacks for observe():
  //    - addedAt (document, atIndex)
  //    - added (document)
  //    - changedAt (newDocument, oldDocument, atIndex)
  //    - changed (newDocument, oldDocument)
  //    - removedAt (document, atIndex)
  //    - removed (document)
  //    - movedTo (document, oldIndex, newIndex)
  //
  // attributes available on returned query handle:
  //  * stop(): end updates
  //  * collection: the collection this query is querying
  //
  // iff x is a returned query handle, (x instanceof
  // LocalCollection.ObserveHandle) is true
  //
  // initial results delivered through added callback
  // XXX maybe callbacks should take a list of objects, to expose transactions?
  // XXX maybe support field limiting (to limit what you're notified on)

  /**
   * @summary Watch a query.  Receive callbacks as the result set changes.
   * @locus Anywhere
   * @memberOf Mongo.Cursor
   * @instance
   * @param {Object} callbacks Functions to call to deliver the result set as it
   *                           changes
   */


  observe(options) {
    return LocalCollection._observeFromObserveChanges(this, options);
  }
  /**
   * @summary Watch a query. Receive callbacks as the result set changes. Only
   *          the differences between the old and new documents are passed to
   *          the callbacks.
   * @locus Anywhere
   * @memberOf Mongo.Cursor
   * @instance
   * @param {Object} callbacks Functions to call to deliver the result set as it
   *                           changes
   */


  observeChanges(options) {
    const ordered = LocalCollection._observeChangesCallbacksAreOrdered(options); // there are several places that assume you aren't combining skip/limit with
    // unordered observe.  eg, update's EJSON.clone, and the "there are several"
    // comment in _modifyAndNotify
    // XXX allow skip/limit with unordered observe


    if (!options._allow_unordered && !ordered && (this.skip || this.limit)) {
      throw new Error("Must use an ordered observe with skip or limit (i.e. 'addedBefore' " + "for observeChanges or 'addedAt' for observe, instead of 'added').");
    }

    if (this.fields && (this.fields._id === 0 || this.fields._id === false)) {
      throw Error('You may not observe a cursor with {fields: {_id: 0}}');
    }

    const distances = this.matcher.hasGeoQuery() && ordered && new LocalCollection._IdMap();
    const query = {
      cursor: this,
      dirty: false,
      distances,
      matcher: this.matcher,
      // not fast pathed
      ordered,
      projectionFn: this._projectionFn,
      resultsSnapshot: null,
      sorter: ordered && this.sorter
    };
    let qid; // Non-reactive queries call added[Before] and then never call anything
    // else.

    if (this.reactive) {
      qid = this.collection.next_qid++;
      this.collection.queries[qid] = query;
    }

    query.results = this._getRawObjects({
      ordered,
      distances: query.distances
    });

    if (this.collection.paused) {
      query.resultsSnapshot = ordered ? [] : new LocalCollection._IdMap();
    } // wrap callbacks we were passed. callbacks only fire when not paused and
    // are never undefined
    // Filters out blacklisted fields according to cursor's projection.
    // XXX wrong place for this?
    // furthermore, callbacks enqueue until the operation we're working on is
    // done.


    const wrapCallback = fn => {
      if (!fn) {
        return () => {};
      }

      const self = this;
      return function
        /* args*/
      () {
        if (self.collection.paused) {
          return;
        }

        const args = arguments;

        self.collection._observeQueue.queueTask(() => {
          fn.apply(this, args);
        });
      };
    };

    query.added = wrapCallback(options.added);
    query.changed = wrapCallback(options.changed);
    query.removed = wrapCallback(options.removed);

    if (ordered) {
      query.addedBefore = wrapCallback(options.addedBefore);
      query.movedBefore = wrapCallback(options.movedBefore);
    }

    if (!options._suppress_initial && !this.collection.paused) {
      query.results.forEach(doc => {
        const fields = EJSON.clone(doc);
        delete fields._id;

        if (ordered) {
          query.addedBefore(doc._id, this._projectionFn(fields), null);
        }

        query.added(doc._id, this._projectionFn(fields));
      });
    }

    const handle = Object.assign(new LocalCollection.ObserveHandle(), {
      collection: this.collection,
      stop: () => {
        if (this.reactive) {
          delete this.collection.queries[qid];
        }
      }
    });

    if (this.reactive && Tracker.active) {
      // XXX in many cases, the same observe will be recreated when
      // the current autorun is rerun.  we could save work by
      // letting it linger across rerun and potentially get
      // repurposed if the same observe is performed, using logic
      // similar to that of Meteor.subscribe.
      Tracker.onInvalidate(() => {
        handle.stop();
      });
    } // run the observe callbacks resulting from the initial contents
    // before we leave the observe.


    this.collection._observeQueue.drain();

    return handle;
  } // XXX Maybe we need a version of observe that just calls a callback if
  // anything changed.


  _depend(changers, _allow_unordered) {
    if (Tracker.active) {
      const dependency = new Tracker.Dependency();
      const notify = dependency.changed.bind(dependency);
      dependency.depend();
      const options = {
        _allow_unordered,
        _suppress_initial: true
      };
      ['added', 'addedBefore', 'changed', 'movedBefore', 'removed'].forEach(fn => {
        if (changers[fn]) {
          options[fn] = notify;
        }
      }); // observeChanges will stop() when this computation is invalidated

      this.observeChanges(options);
    }
  }

  _getCollectionName() {
    return this.collection.name;
  } // Returns a collection of matching objects, but doesn't deep copy them.
  //
  // If ordered is set, returns a sorted array, respecting sorter, skip, and
  // limit properties of the query provided that options.applySkipLimit is
  // not set to false (#1201). If sorter is falsey, no sort -- you get the
  // natural order.
  //
  // If ordered is not set, returns an object mapping from ID to doc (sorter,
  // skip and limit should not be set).
  //
  // If ordered is set and this cursor is a $near geoquery, then this function
  // will use an _IdMap to track each distance from the $near argument point in
  // order to use it as a sort key. If an _IdMap is passed in the 'distances'
  // argument, this function will clear it and use it for this purpose
  // (otherwise it will just create its own _IdMap). The observeChanges
  // implementation uses this to remember the distances after this function
  // returns.


  _getRawObjects() {
    let options = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};
    // By default this method will respect skip and limit because .fetch(),
    // .forEach() etc... expect this behaviour. It can be forced to ignore
    // skip and limit by setting applySkipLimit to false (.count() does this,
    // for example)
    const applySkipLimit = options.applySkipLimit !== false; // XXX use OrderedDict instead of array, and make IdMap and OrderedDict
    // compatible

    const results = options.ordered ? [] : new LocalCollection._IdMap(); // fast path for single ID value

    if (this._selectorId !== undefined) {
      // If you have non-zero skip and ask for a single id, you get nothing.
      // This is so it matches the behavior of the '{_id: foo}' path.
      if (applySkipLimit && this.skip) {
        return results;
      }

      const selectedDoc = this.collection._docs.get(this._selectorId);

      if (selectedDoc) {
        if (options.ordered) {
          results.push(selectedDoc);
        } else {
          results.set(this._selectorId, selectedDoc);
        }
      }

      return results;
    } // slow path for arbitrary selector, sort, skip, limit
    // in the observeChanges case, distances is actually part of the "query"
    // (ie, live results set) object.  in other cases, distances is only used
    // inside this function.


    let distances;

    if (this.matcher.hasGeoQuery() && options.ordered) {
      if (options.distances) {
        distances = options.distances;
        distances.clear();
      } else {
        distances = new LocalCollection._IdMap();
      }
    }

    this.collection._docs.forEach((doc, id) => {
      const matchResult = this.matcher.documentMatches(doc);

      if (matchResult.result) {
        if (options.ordered) {
          results.push(doc);

          if (distances && matchResult.distance !== undefined) {
            distances.set(id, matchResult.distance);
          }
        } else {
          results.set(id, doc);
        }
      } // Override to ensure all docs are matched if ignoring skip & limit


      if (!applySkipLimit) {
        return true;
      } // Fast path for limited unsorted queries.
      // XXX 'length' check here seems wrong for ordered


      return !this.limit || this.skip || this.sorter || results.length !== this.limit;
    });

    if (!options.ordered) {
      return results;
    }

    if (this.sorter) {
      results.sort(this.sorter.getComparator({
        distances
      }));
    } // Return the full set of results if there is no skip or limit or if we're
    // ignoring them


    if (!applySkipLimit || !this.limit && !this.skip) {
      return results;
    }

    return results.slice(this.skip, this.limit ? this.limit + this.skip : results.length);
  }

  _publishCursor(subscription) {
    // XXX minimongo should not depend on mongo-livedata!
    if (!Package.mongo) {
      throw new Error('Can\'t publish from Minimongo without the `mongo` package.');
    }

    if (!this.collection.name) {
      throw new Error('Can\'t publish a cursor from a collection without a name.');
    }

    return Package.mongo.Mongo.Collection._publishCursor(this, subscription, this.collection.name);
  }

}

// Implements async version of cursor methods to keep collections isomorphic
ASYNC_CURSOR_METHODS.forEach(method => {
  const asyncName = getAsyncMethodName(method);

  Cursor.prototype[asyncName] = function () {
    for (var _len = arguments.length, args = new Array(_len), _key = 0; _key < _len; _key++) {
      args[_key] = arguments[_key];
    }

    return Promise.resolve(this[method].apply(this, args));
  };
});
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"local_collection.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/minimongo/local_collection.js                                                                              //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
let _objectSpread;

module.link("@babel/runtime/helpers/objectSpread2", {
  default(v) {
    _objectSpread = v;
  }

}, 0);
module.export({
  default: () => LocalCollection
});
let Cursor;
module.link("./cursor.js", {
  default(v) {
    Cursor = v;
  }

}, 0);
let ObserveHandle;
module.link("./observe_handle.js", {
  default(v) {
    ObserveHandle = v;
  }

}, 1);
let hasOwn, isIndexable, isNumericKey, isOperatorObject, populateDocumentWithQueryFields, projectionDetails;
module.link("./common.js", {
  hasOwn(v) {
    hasOwn = v;
  },

  isIndexable(v) {
    isIndexable = v;
  },

  isNumericKey(v) {
    isNumericKey = v;
  },

  isOperatorObject(v) {
    isOperatorObject = v;
  },

  populateDocumentWithQueryFields(v) {
    populateDocumentWithQueryFields = v;
  },

  projectionDetails(v) {
    projectionDetails = v;
  }

}, 2);

class LocalCollection {
  constructor(name) {
    this.name = name; // _id -> document (also containing id)

    this._docs = new LocalCollection._IdMap();
    this._observeQueue = new Meteor._SynchronousQueue();
    this.next_qid = 1; // live query id generator
    // qid -> live query object. keys:
    //  ordered: bool. ordered queries have addedBefore/movedBefore callbacks.
    //  results: array (ordered) or object (unordered) of current results
    //    (aliased with this._docs!)
    //  resultsSnapshot: snapshot of results. null if not paused.
    //  cursor: Cursor object for the query.
    //  selector, sorter, (callbacks): functions

    this.queries = Object.create(null); // null if not saving originals; an IdMap from id to original document value
    // if saving originals. See comments before saveOriginals().

    this._savedOriginals = null; // True when observers are paused and we should not send callbacks.

    this.paused = false;
  } // options may include sort, skip, limit, reactive
  // sort may be any of these forms:
  //     {a: 1, b: -1}
  //     [["a", "asc"], ["b", "desc"]]
  //     ["a", ["b", "desc"]]
  //   (in the first form you're beholden to key enumeration order in
  //   your javascript VM)
  //
  // reactive: if given, and false, don't register with Tracker (default
  // is true)
  //
  // XXX possibly should support retrieving a subset of fields? and
  // have it be a hint (ignored on the client, when not copying the
  // doc?)
  //
  // XXX sort does not yet support subkeys ('a.b') .. fix that!
  // XXX add one more sort form: "key"
  // XXX tests


  find(selector, options) {
    // default syntax for everything is to omit the selector argument.
    // but if selector is explicitly passed in as false or undefined, we
    // want a selector that matches nothing.
    if (arguments.length === 0) {
      selector = {};
    }

    return new LocalCollection.Cursor(this, selector, options);
  }

  findOne(selector) {
    let options = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};

    if (arguments.length === 0) {
      selector = {};
    } // NOTE: by setting limit 1 here, we end up using very inefficient
    // code that recomputes the whole query on each update. The upside is
    // that when you reactively depend on a findOne you only get
    // invalidated when the found object changes, not any object in the
    // collection. Most findOne will be by id, which has a fast path, so
    // this might not be a big deal. In most cases, invalidation causes
    // the called to re-query anyway, so this should be a net performance
    // improvement.


    options.limit = 1;
    return this.find(selector, options).fetch()[0];
  } // XXX possibly enforce that 'undefined' does not appear (we assume
  // this in our handling of null and $exists)


  insert(doc, callback) {
    doc = EJSON.clone(doc);
    assertHasValidFieldNames(doc); // if you really want to use ObjectIDs, set this global.
    // Mongo.Collection specifies its own ids and does not use this code.

    if (!hasOwn.call(doc, '_id')) {
      doc._id = LocalCollection._useOID ? new MongoID.ObjectID() : Random.id();
    }

    const id = doc._id;

    if (this._docs.has(id)) {
      throw MinimongoError("Duplicate _id '".concat(id, "'"));
    }

    this._saveOriginal(id, undefined);

    this._docs.set(id, doc);

    const queriesToRecompute = []; // trigger live queries that match

    Object.keys(this.queries).forEach(qid => {
      const query = this.queries[qid];

      if (query.dirty) {
        return;
      }

      const matchResult = query.matcher.documentMatches(doc);

      if (matchResult.result) {
        if (query.distances && matchResult.distance !== undefined) {
          query.distances.set(id, matchResult.distance);
        }

        if (query.cursor.skip || query.cursor.limit) {
          queriesToRecompute.push(qid);
        } else {
          LocalCollection._insertInResults(query, doc);
        }
      }
    });
    queriesToRecompute.forEach(qid => {
      if (this.queries[qid]) {
        this._recomputeResults(this.queries[qid]);
      }
    });

    this._observeQueue.drain(); // Defer because the caller likely doesn't expect the callback to be run
    // immediately.


    if (callback) {
      Meteor.defer(() => {
        callback(null, id);
      });
    }

    return id;
  } // Pause the observers. No callbacks from observers will fire until
  // 'resumeObservers' is called.


  pauseObservers() {
    // No-op if already paused.
    if (this.paused) {
      return;
    } // Set the 'paused' flag such that new observer messages don't fire.


    this.paused = true; // Take a snapshot of the query results for each query.

    Object.keys(this.queries).forEach(qid => {
      const query = this.queries[qid];
      query.resultsSnapshot = EJSON.clone(query.results);
    });
  }

  remove(selector, callback) {
    // Easy special case: if we're not calling observeChanges callbacks and
    // we're not saving originals and we got asked to remove everything, then
    // just empty everything directly.
    if (this.paused && !this._savedOriginals && EJSON.equals(selector, {})) {
      const result = this._docs.size();

      this._docs.clear();

      Object.keys(this.queries).forEach(qid => {
        const query = this.queries[qid];

        if (query.ordered) {
          query.results = [];
        } else {
          query.results.clear();
        }
      });

      if (callback) {
        Meteor.defer(() => {
          callback(null, result);
        });
      }

      return result;
    }

    const matcher = new Minimongo.Matcher(selector);
    const remove = [];

    this._eachPossiblyMatchingDoc(selector, (doc, id) => {
      if (matcher.documentMatches(doc).result) {
        remove.push(id);
      }
    });

    const queriesToRecompute = [];
    const queryRemove = [];

    for (let i = 0; i < remove.length; i++) {
      const removeId = remove[i];

      const removeDoc = this._docs.get(removeId);

      Object.keys(this.queries).forEach(qid => {
        const query = this.queries[qid];

        if (query.dirty) {
          return;
        }

        if (query.matcher.documentMatches(removeDoc).result) {
          if (query.cursor.skip || query.cursor.limit) {
            queriesToRecompute.push(qid);
          } else {
            queryRemove.push({
              qid,
              doc: removeDoc
            });
          }
        }
      });

      this._saveOriginal(removeId, removeDoc);

      this._docs.remove(removeId);
    } // run live query callbacks _after_ we've removed the documents.


    queryRemove.forEach(remove => {
      const query = this.queries[remove.qid];

      if (query) {
        query.distances && query.distances.remove(remove.doc._id);

        LocalCollection._removeFromResults(query, remove.doc);
      }
    });
    queriesToRecompute.forEach(qid => {
      const query = this.queries[qid];

      if (query) {
        this._recomputeResults(query);
      }
    });

    this._observeQueue.drain();

    const result = remove.length;

    if (callback) {
      Meteor.defer(() => {
        callback(null, result);
      });
    }

    return result;
  } // Resume the observers. Observers immediately receive change
  // notifications to bring them to the current state of the
  // database. Note that this is not just replaying all the changes that
  // happened during the pause, it is a smarter 'coalesced' diff.


  resumeObservers() {
    // No-op if not paused.
    if (!this.paused) {
      return;
    } // Unset the 'paused' flag. Make sure to do this first, otherwise
    // observer methods won't actually fire when we trigger them.


    this.paused = false;
    Object.keys(this.queries).forEach(qid => {
      const query = this.queries[qid];

      if (query.dirty) {
        query.dirty = false; // re-compute results will perform `LocalCollection._diffQueryChanges`
        // automatically.

        this._recomputeResults(query, query.resultsSnapshot);
      } else {
        // Diff the current results against the snapshot and send to observers.
        // pass the query object for its observer callbacks.
        LocalCollection._diffQueryChanges(query.ordered, query.resultsSnapshot, query.results, query, {
          projectionFn: query.projectionFn
        });
      }

      query.resultsSnapshot = null;
    });

    this._observeQueue.drain();
  }

  retrieveOriginals() {
    if (!this._savedOriginals) {
      throw new Error('Called retrieveOriginals without saveOriginals');
    }

    const originals = this._savedOriginals;
    this._savedOriginals = null;
    return originals;
  } // To track what documents are affected by a piece of code, call
  // saveOriginals() before it and retrieveOriginals() after it.
  // retrieveOriginals returns an object whose keys are the ids of the documents
  // that were affected since the call to saveOriginals(), and the values are
  // equal to the document's contents at the time of saveOriginals. (In the case
  // of an inserted document, undefined is the value.) You must alternate
  // between calls to saveOriginals() and retrieveOriginals().


  saveOriginals() {
    if (this._savedOriginals) {
      throw new Error('Called saveOriginals twice without retrieveOriginals');
    }

    this._savedOriginals = new LocalCollection._IdMap();
  } // XXX atomicity: if multi is true, and one modification fails, do
  // we rollback the whole operation, or what?


  update(selector, mod, options, callback) {
    if (!callback && options instanceof Function) {
      callback = options;
      options = null;
    }

    if (!options) {
      options = {};
    }

    const matcher = new Minimongo.Matcher(selector, true); // Save the original results of any query that we might need to
    // _recomputeResults on, because _modifyAndNotify will mutate the objects in
    // it. (We don't need to save the original results of paused queries because
    // they already have a resultsSnapshot and we won't be diffing in
    // _recomputeResults.)

    const qidToOriginalResults = {}; // We should only clone each document once, even if it appears in multiple
    // queries

    const docMap = new LocalCollection._IdMap();

    const idsMatched = LocalCollection._idsMatchedBySelector(selector);

    Object.keys(this.queries).forEach(qid => {
      const query = this.queries[qid];

      if ((query.cursor.skip || query.cursor.limit) && !this.paused) {
        // Catch the case of a reactive `count()` on a cursor with skip
        // or limit, which registers an unordered observe. This is a
        // pretty rare case, so we just clone the entire result set with
        // no optimizations for documents that appear in these result
        // sets and other queries.
        if (query.results instanceof LocalCollection._IdMap) {
          qidToOriginalResults[qid] = query.results.clone();
          return;
        }

        if (!(query.results instanceof Array)) {
          throw new Error('Assertion failed: query.results not an array');
        } // Clones a document to be stored in `qidToOriginalResults`
        // because it may be modified before the new and old result sets
        // are diffed. But if we know exactly which document IDs we're
        // going to modify, then we only need to clone those.


        const memoizedCloneIfNeeded = doc => {
          if (docMap.has(doc._id)) {
            return docMap.get(doc._id);
          }

          const docToMemoize = idsMatched && !idsMatched.some(id => EJSON.equals(id, doc._id)) ? doc : EJSON.clone(doc);
          docMap.set(doc._id, docToMemoize);
          return docToMemoize;
        };

        qidToOriginalResults[qid] = query.results.map(memoizedCloneIfNeeded);
      }
    });
    const recomputeQids = {};
    let updateCount = 0;

    this._eachPossiblyMatchingDoc(selector, (doc, id) => {
      const queryResult = matcher.documentMatches(doc);

      if (queryResult.result) {
        // XXX Should we save the original even if mod ends up being a no-op?
        this._saveOriginal(id, doc);

        this._modifyAndNotify(doc, mod, recomputeQids, queryResult.arrayIndices);

        ++updateCount;

        if (!options.multi) {
          return false; // break
        }
      }

      return true;
    });

    Object.keys(recomputeQids).forEach(qid => {
      const query = this.queries[qid];

      if (query) {
        this._recomputeResults(query, qidToOriginalResults[qid]);
      }
    });

    this._observeQueue.drain(); // If we are doing an upsert, and we didn't modify any documents yet, then
    // it's time to do an insert. Figure out what document we are inserting, and
    // generate an id for it.


    let insertedId;

    if (updateCount === 0 && options.upsert) {
      const doc = LocalCollection._createUpsertDocument(selector, mod);

      if (!doc._id && options.insertedId) {
        doc._id = options.insertedId;
      }

      insertedId = this.insert(doc);
      updateCount = 1;
    } // Return the number of affected documents, or in the upsert case, an object
    // containing the number of affected docs and the id of the doc that was
    // inserted, if any.


    let result;

    if (options._returnObject) {
      result = {
        numberAffected: updateCount
      };

      if (insertedId !== undefined) {
        result.insertedId = insertedId;
      }
    } else {
      result = updateCount;
    }

    if (callback) {
      Meteor.defer(() => {
        callback(null, result);
      });
    }

    return result;
  } // A convenience wrapper on update. LocalCollection.upsert(sel, mod) is
  // equivalent to LocalCollection.update(sel, mod, {upsert: true,
  // _returnObject: true}).


  upsert(selector, mod, options, callback) {
    if (!callback && typeof options === 'function') {
      callback = options;
      options = {};
    }

    return this.update(selector, mod, Object.assign({}, options, {
      upsert: true,
      _returnObject: true
    }), callback);
  } // Iterates over a subset of documents that could match selector; calls
  // fn(doc, id) on each of them.  Specifically, if selector specifies
  // specific _id's, it only looks at those.  doc is *not* cloned: it is the
  // same object that is in _docs.


  _eachPossiblyMatchingDoc(selector, fn) {
    const specificIds = LocalCollection._idsMatchedBySelector(selector);

    if (specificIds) {
      specificIds.some(id => {
        const doc = this._docs.get(id);

        if (doc) {
          return fn(doc, id) === false;
        }
      });
    } else {
      this._docs.forEach(fn);
    }
  }

  _modifyAndNotify(doc, mod, recomputeQids, arrayIndices) {
    const matched_before = {};
    Object.keys(this.queries).forEach(qid => {
      const query = this.queries[qid];

      if (query.dirty) {
        return;
      }

      if (query.ordered) {
        matched_before[qid] = query.matcher.documentMatches(doc).result;
      } else {
        // Because we don't support skip or limit (yet) in unordered queries, we
        // can just do a direct lookup.
        matched_before[qid] = query.results.has(doc._id);
      }
    });
    const old_doc = EJSON.clone(doc);

    LocalCollection._modify(doc, mod, {
      arrayIndices
    });

    Object.keys(this.queries).forEach(qid => {
      const query = this.queries[qid];

      if (query.dirty) {
        return;
      }

      const afterMatch = query.matcher.documentMatches(doc);
      const after = afterMatch.result;
      const before = matched_before[qid];

      if (after && query.distances && afterMatch.distance !== undefined) {
        query.distances.set(doc._id, afterMatch.distance);
      }

      if (query.cursor.skip || query.cursor.limit) {
        // We need to recompute any query where the doc may have been in the
        // cursor's window either before or after the update. (Note that if skip
        // or limit is set, "before" and "after" being true do not necessarily
        // mean that the document is in the cursor's output after skip/limit is
        // applied... but if they are false, then the document definitely is NOT
        // in the output. So it's safe to skip recompute if neither before or
        // after are true.)
        if (before || after) {
          recomputeQids[qid] = true;
        }
      } else if (before && !after) {
        LocalCollection._removeFromResults(query, doc);
      } else if (!before && after) {
        LocalCollection._insertInResults(query, doc);
      } else if (before && after) {
        LocalCollection._updateInResults(query, doc, old_doc);
      }
    });
  } // Recomputes the results of a query and runs observe callbacks for the
  // difference between the previous results and the current results (unless
  // paused). Used for skip/limit queries.
  //
  // When this is used by insert or remove, it can just use query.results for
  // the old results (and there's no need to pass in oldResults), because these
  // operations don't mutate the documents in the collection. Update needs to
  // pass in an oldResults which was deep-copied before the modifier was
  // applied.
  //
  // oldResults is guaranteed to be ignored if the query is not paused.


  _recomputeResults(query, oldResults) {
    if (this.paused) {
      // There's no reason to recompute the results now as we're still paused.
      // By flagging the query as "dirty", the recompute will be performed
      // when resumeObservers is called.
      query.dirty = true;
      return;
    }

    if (!this.paused && !oldResults) {
      oldResults = query.results;
    }

    if (query.distances) {
      query.distances.clear();
    }

    query.results = query.cursor._getRawObjects({
      distances: query.distances,
      ordered: query.ordered
    });

    if (!this.paused) {
      LocalCollection._diffQueryChanges(query.ordered, oldResults, query.results, query, {
        projectionFn: query.projectionFn
      });
    }
  }

  _saveOriginal(id, doc) {
    // Are we even trying to save originals?
    if (!this._savedOriginals) {
      return;
    } // Have we previously mutated the original (and so 'doc' is not actually
    // original)?  (Note the 'has' check rather than truth: we store undefined
    // here for inserted docs!)


    if (this._savedOriginals.has(id)) {
      return;
    }

    this._savedOriginals.set(id, EJSON.clone(doc));
  }

}

LocalCollection.Cursor = Cursor;
LocalCollection.ObserveHandle = ObserveHandle; // XXX maybe move these into another ObserveHelpers package or something
// _CachingChangeObserver is an object which receives observeChanges callbacks
// and keeps a cache of the current cursor state up to date in this.docs. Users
// of this class should read the docs field but not modify it. You should pass
// the "applyChange" field as the callbacks to the underlying observeChanges
// call. Optionally, you can specify your own observeChanges callbacks which are
// invoked immediately before the docs field is updated; this object is made
// available as `this` to those callbacks.

LocalCollection._CachingChangeObserver = class _CachingChangeObserver {
  constructor() {
    let options = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};

    const orderedFromCallbacks = options.callbacks && LocalCollection._observeChangesCallbacksAreOrdered(options.callbacks);

    if (hasOwn.call(options, 'ordered')) {
      this.ordered = options.ordered;

      if (options.callbacks && options.ordered !== orderedFromCallbacks) {
        throw Error('ordered option doesn\'t match callbacks');
      }
    } else if (options.callbacks) {
      this.ordered = orderedFromCallbacks;
    } else {
      throw Error('must provide ordered or callbacks');
    }

    const callbacks = options.callbacks || {};

    if (this.ordered) {
      this.docs = new OrderedDict(MongoID.idStringify);
      this.applyChange = {
        addedBefore: (id, fields, before) => {
          // Take a shallow copy since the top-level properties can be changed
          const doc = _objectSpread({}, fields);

          doc._id = id;

          if (callbacks.addedBefore) {
            callbacks.addedBefore.call(this, id, EJSON.clone(fields), before);
          } // This line triggers if we provide added with movedBefore.


          if (callbacks.added) {
            callbacks.added.call(this, id, EJSON.clone(fields));
          } // XXX could `before` be a falsy ID?  Technically
          // idStringify seems to allow for them -- though
          // OrderedDict won't call stringify on a falsy arg.


          this.docs.putBefore(id, doc, before || null);
        },
        movedBefore: (id, before) => {
          const doc = this.docs.get(id);

          if (callbacks.movedBefore) {
            callbacks.movedBefore.call(this, id, before);
          }

          this.docs.moveBefore(id, before || null);
        }
      };
    } else {
      this.docs = new LocalCollection._IdMap();
      this.applyChange = {
        added: (id, fields) => {
          // Take a shallow copy since the top-level properties can be changed
          const doc = _objectSpread({}, fields);

          if (callbacks.added) {
            callbacks.added.call(this, id, EJSON.clone(fields));
          }

          doc._id = id;
          this.docs.set(id, doc);
        }
      };
    } // The methods in _IdMap and OrderedDict used by these callbacks are
    // identical.


    this.applyChange.changed = (id, fields) => {
      const doc = this.docs.get(id);

      if (!doc) {
        throw new Error("Unknown id for changed: ".concat(id));
      }

      if (callbacks.changed) {
        callbacks.changed.call(this, id, EJSON.clone(fields));
      }

      DiffSequence.applyChanges(doc, fields);
    };

    this.applyChange.removed = id => {
      if (callbacks.removed) {
        callbacks.removed.call(this, id);
      }

      this.docs.remove(id);
    };
  }

};
LocalCollection._IdMap = class _IdMap extends IdMap {
  constructor() {
    super(MongoID.idStringify, MongoID.idParse);
  }

}; // Wrap a transform function to return objects that have the _id field
// of the untransformed document. This ensures that subsystems such as
// the observe-sequence package that call `observe` can keep track of
// the documents identities.
//
// - Require that it returns objects
// - If the return value has an _id field, verify that it matches the
//   original _id field
// - If the return value doesn't have an _id field, add it back.

LocalCollection.wrapTransform = transform => {
  if (!transform) {
    return null;
  } // No need to doubly-wrap transforms.


  if (transform.__wrappedTransform__) {
    return transform;
  }

  const wrapped = doc => {
    if (!hasOwn.call(doc, '_id')) {
      // XXX do we ever have a transform on the oplog's collection? because that
      // collection has no _id.
      throw new Error('can only transform documents with _id');
    }

    const id = doc._id; // XXX consider making tracker a weak dependency and checking
    // Package.tracker here

    const transformed = Tracker.nonreactive(() => transform(doc));

    if (!LocalCollection._isPlainObject(transformed)) {
      throw new Error('transform must return object');
    }

    if (hasOwn.call(transformed, '_id')) {
      if (!EJSON.equals(transformed._id, id)) {
        throw new Error('transformed document can\'t have different _id');
      }
    } else {
      transformed._id = id;
    }

    return transformed;
  };

  wrapped.__wrappedTransform__ = true;
  return wrapped;
}; // XXX the sorted-query logic below is laughably inefficient. we'll
// need to come up with a better datastructure for this.
//
// XXX the logic for observing with a skip or a limit is even more
// laughably inefficient. we recompute the whole results every time!
// This binary search puts a value between any equal values, and the first
// lesser value.


LocalCollection._binarySearch = (cmp, array, value) => {
  let first = 0;
  let range = array.length;

  while (range > 0) {
    const halfRange = Math.floor(range / 2);

    if (cmp(value, array[first + halfRange]) >= 0) {
      first += halfRange + 1;
      range -= halfRange + 1;
    } else {
      range = halfRange;
    }
  }

  return first;
};

LocalCollection._checkSupportedProjection = fields => {
  if (fields !== Object(fields) || Array.isArray(fields)) {
    throw MinimongoError('fields option must be an object');
  }

  Object.keys(fields).forEach(keyPath => {
    if (keyPath.split('.').includes('$')) {
      throw MinimongoError('Minimongo doesn\'t support $ operator in projections yet.');
    }

    const value = fields[keyPath];

    if (typeof value === 'object' && ['$elemMatch', '$meta', '$slice'].some(key => hasOwn.call(value, key))) {
      throw MinimongoError('Minimongo doesn\'t support operators in projections yet.');
    }

    if (![1, 0, true, false].includes(value)) {
      throw MinimongoError('Projection values should be one of 1, 0, true, or false');
    }
  });
}; // Knows how to compile a fields projection to a predicate function.
// @returns - Function: a closure that filters out an object according to the
//            fields projection rules:
//            @param obj - Object: MongoDB-styled document
//            @returns - Object: a document with the fields filtered out
//                       according to projection rules. Doesn't retain subfields
//                       of passed argument.


LocalCollection._compileProjection = fields => {
  LocalCollection._checkSupportedProjection(fields);

  const _idProjection = fields._id === undefined ? true : fields._id;

  const details = projectionDetails(fields); // returns transformed doc according to ruleTree

  const transform = (doc, ruleTree) => {
    // Special case for "sets"
    if (Array.isArray(doc)) {
      return doc.map(subdoc => transform(subdoc, ruleTree));
    }

    const result = details.including ? {} : EJSON.clone(doc);
    Object.keys(ruleTree).forEach(key => {
      if (doc == null || !hasOwn.call(doc, key)) {
        return;
      }

      const rule = ruleTree[key];

      if (rule === Object(rule)) {
        // For sub-objects/subsets we branch
        if (doc[key] === Object(doc[key])) {
          result[key] = transform(doc[key], rule);
        }
      } else if (details.including) {
        // Otherwise we don't even touch this subfield
        result[key] = EJSON.clone(doc[key]);
      } else {
        delete result[key];
      }
    });
    return doc != null ? result : doc;
  };

  return doc => {
    const result = transform(doc, details.tree);

    if (_idProjection && hasOwn.call(doc, '_id')) {
      result._id = doc._id;
    }

    if (!_idProjection && hasOwn.call(result, '_id')) {
      delete result._id;
    }

    return result;
  };
}; // Calculates the document to insert in case we're doing an upsert and the
// selector does not match any elements


LocalCollection._createUpsertDocument = (selector, modifier) => {
  const selectorDocument = populateDocumentWithQueryFields(selector);

  const isModify = LocalCollection._isModificationMod(modifier);

  const newDoc = {};

  if (selectorDocument._id) {
    newDoc._id = selectorDocument._id;
    delete selectorDocument._id;
  } // This double _modify call is made to help with nested properties (see issue
  // #8631). We do this even if it's a replacement for validation purposes (e.g.
  // ambiguous id's)


  LocalCollection._modify(newDoc, {
    $set: selectorDocument
  });

  LocalCollection._modify(newDoc, modifier, {
    isInsert: true
  });

  if (isModify) {
    return newDoc;
  } // Replacement can take _id from query document


  const replacement = Object.assign({}, modifier);

  if (newDoc._id) {
    replacement._id = newDoc._id;
  }

  return replacement;
};

LocalCollection._diffObjects = (left, right, callbacks) => {
  return DiffSequence.diffObjects(left, right, callbacks);
}; // ordered: bool.
// old_results and new_results: collections of documents.
//    if ordered, they are arrays.
//    if unordered, they are IdMaps


LocalCollection._diffQueryChanges = (ordered, oldResults, newResults, observer, options) => DiffSequence.diffQueryChanges(ordered, oldResults, newResults, observer, options);

LocalCollection._diffQueryOrderedChanges = (oldResults, newResults, observer, options) => DiffSequence.diffQueryOrderedChanges(oldResults, newResults, observer, options);

LocalCollection._diffQueryUnorderedChanges = (oldResults, newResults, observer, options) => DiffSequence.diffQueryUnorderedChanges(oldResults, newResults, observer, options);

LocalCollection._findInOrderedResults = (query, doc) => {
  if (!query.ordered) {
    throw new Error('Can\'t call _findInOrderedResults on unordered query');
  }

  for (let i = 0; i < query.results.length; i++) {
    if (query.results[i] === doc) {
      return i;
    }
  }

  throw Error('object missing from query');
}; // If this is a selector which explicitly constrains the match by ID to a finite
// number of documents, returns a list of their IDs.  Otherwise returns
// null. Note that the selector may have other restrictions so it may not even
// match those document!  We care about $in and $and since those are generated
// access-controlled update and remove.


LocalCollection._idsMatchedBySelector = selector => {
  // Is the selector just an ID?
  if (LocalCollection._selectorIsId(selector)) {
    return [selector];
  }

  if (!selector) {
    return null;
  } // Do we have an _id clause?


  if (hasOwn.call(selector, '_id')) {
    // Is the _id clause just an ID?
    if (LocalCollection._selectorIsId(selector._id)) {
      return [selector._id];
    } // Is the _id clause {_id: {$in: ["x", "y", "z"]}}?


    if (selector._id && Array.isArray(selector._id.$in) && selector._id.$in.length && selector._id.$in.every(LocalCollection._selectorIsId)) {
      return selector._id.$in;
    }

    return null;
  } // If this is a top-level $and, and any of the clauses constrain their
  // documents, then the whole selector is constrained by any one clause's
  // constraint. (Well, by their intersection, but that seems unlikely.)


  if (Array.isArray(selector.$and)) {
    for (let i = 0; i < selector.$and.length; ++i) {
      const subIds = LocalCollection._idsMatchedBySelector(selector.$and[i]);

      if (subIds) {
        return subIds;
      }
    }
  }

  return null;
};

LocalCollection._insertInResults = (query, doc) => {
  const fields = EJSON.clone(doc);
  delete fields._id;

  if (query.ordered) {
    if (!query.sorter) {
      query.addedBefore(doc._id, query.projectionFn(fields), null);
      query.results.push(doc);
    } else {
      const i = LocalCollection._insertInSortedList(query.sorter.getComparator({
        distances: query.distances
      }), query.results, doc);

      let next = query.results[i + 1];

      if (next) {
        next = next._id;
      } else {
        next = null;
      }

      query.addedBefore(doc._id, query.projectionFn(fields), next);
    }

    query.added(doc._id, query.projectionFn(fields));
  } else {
    query.added(doc._id, query.projectionFn(fields));
    query.results.set(doc._id, doc);
  }
};

LocalCollection._insertInSortedList = (cmp, array, value) => {
  if (array.length === 0) {
    array.push(value);
    return 0;
  }

  const i = LocalCollection._binarySearch(cmp, array, value);

  array.splice(i, 0, value);
  return i;
};

LocalCollection._isModificationMod = mod => {
  let isModify = false;
  let isReplace = false;
  Object.keys(mod).forEach(key => {
    if (key.substr(0, 1) === '$') {
      isModify = true;
    } else {
      isReplace = true;
    }
  });

  if (isModify && isReplace) {
    throw new Error('Update parameter cannot have both modifier and non-modifier fields.');
  }

  return isModify;
}; // XXX maybe this should be EJSON.isObject, though EJSON doesn't know about
// RegExp
// XXX note that _type(undefined) === 3!!!!


LocalCollection._isPlainObject = x => {
  return x && LocalCollection._f._type(x) === 3;
}; // XXX need a strategy for passing the binding of $ into this
// function, from the compiled selector
//
// maybe just {key.up.to.just.before.dollarsign: array_index}
//
// XXX atomicity: if one modification fails, do we roll back the whole
// change?
//
// options:
//   - isInsert is set when _modify is being called to compute the document to
//     insert as part of an upsert operation. We use this primarily to figure
//     out when to set the fields in $setOnInsert, if present.


LocalCollection._modify = function (doc, modifier) {
  let options = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};

  if (!LocalCollection._isPlainObject(modifier)) {
    throw MinimongoError('Modifier must be an object');
  } // Make sure the caller can't mutate our data structures.


  modifier = EJSON.clone(modifier);
  const isModifier = isOperatorObject(modifier);
  const newDoc = isModifier ? EJSON.clone(doc) : modifier;

  if (isModifier) {
    // apply modifiers to the doc.
    Object.keys(modifier).forEach(operator => {
      // Treat $setOnInsert as $set if this is an insert.
      const setOnInsert = options.isInsert && operator === '$setOnInsert';
      const modFunc = MODIFIERS[setOnInsert ? '$set' : operator];
      const operand = modifier[operator];

      if (!modFunc) {
        throw MinimongoError("Invalid modifier specified ".concat(operator));
      }

      Object.keys(operand).forEach(keypath => {
        const arg = operand[keypath];

        if (keypath === '') {
          throw MinimongoError('An empty update path is not valid.');
        }

        const keyparts = keypath.split('.');

        if (!keyparts.every(Boolean)) {
          throw MinimongoError("The update path '".concat(keypath, "' contains an empty field name, ") + 'which is not allowed.');
        }

        const target = findModTarget(newDoc, keyparts, {
          arrayIndices: options.arrayIndices,
          forbidArray: operator === '$rename',
          noCreate: NO_CREATE_MODIFIERS[operator]
        });
        modFunc(target, keyparts.pop(), arg, keypath, newDoc);
      });
    });

    if (doc._id && !EJSON.equals(doc._id, newDoc._id)) {
      throw MinimongoError("After applying the update to the document {_id: \"".concat(doc._id, "\", ...},") + ' the (immutable) field \'_id\' was found to have been altered to ' + "_id: \"".concat(newDoc._id, "\""));
    }
  } else {
    if (doc._id && modifier._id && !EJSON.equals(doc._id, modifier._id)) {
      throw MinimongoError("The _id field cannot be changed from {_id: \"".concat(doc._id, "\"} to ") + "{_id: \"".concat(modifier._id, "\"}"));
    } // replace the whole document


    assertHasValidFieldNames(modifier);
  } // move new document into place.


  Object.keys(doc).forEach(key => {
    // Note: this used to be for (var key in doc) however, this does not
    // work right in Opera. Deleting from a doc while iterating over it
    // would sometimes cause opera to skip some keys.
    if (key !== '_id') {
      delete doc[key];
    }
  });
  Object.keys(newDoc).forEach(key => {
    doc[key] = newDoc[key];
  });
};

LocalCollection._observeFromObserveChanges = (cursor, observeCallbacks) => {
  const transform = cursor.getTransform() || (doc => doc);

  let suppressed = !!observeCallbacks._suppress_initial;
  let observeChangesCallbacks;

  if (LocalCollection._observeCallbacksAreOrdered(observeCallbacks)) {
    // The "_no_indices" option sets all index arguments to -1 and skips the
    // linear scans required to generate them.  This lets observers that don't
    // need absolute indices benefit from the other features of this API --
    // relative order, transforms, and applyChanges -- without the speed hit.
    const indices = !observeCallbacks._no_indices;
    observeChangesCallbacks = {
      addedBefore(id, fields, before) {
        if (suppressed || !(observeCallbacks.addedAt || observeCallbacks.added)) {
          return;
        }

        const doc = transform(Object.assign(fields, {
          _id: id
        }));

        if (observeCallbacks.addedAt) {
          observeCallbacks.addedAt(doc, indices ? before ? this.docs.indexOf(before) : this.docs.size() : -1, before);
        } else {
          observeCallbacks.added(doc);
        }
      },

      changed(id, fields) {
        if (!(observeCallbacks.changedAt || observeCallbacks.changed)) {
          return;
        }

        let doc = EJSON.clone(this.docs.get(id));

        if (!doc) {
          throw new Error("Unknown id for changed: ".concat(id));
        }

        const oldDoc = transform(EJSON.clone(doc));
        DiffSequence.applyChanges(doc, fields);

        if (observeCallbacks.changedAt) {
          observeCallbacks.changedAt(transform(doc), oldDoc, indices ? this.docs.indexOf(id) : -1);
        } else {
          observeCallbacks.changed(transform(doc), oldDoc);
        }
      },

      movedBefore(id, before) {
        if (!observeCallbacks.movedTo) {
          return;
        }

        const from = indices ? this.docs.indexOf(id) : -1;
        let to = indices ? before ? this.docs.indexOf(before) : this.docs.size() : -1; // When not moving backwards, adjust for the fact that removing the
        // document slides everything back one slot.

        if (to > from) {
          --to;
        }

        observeCallbacks.movedTo(transform(EJSON.clone(this.docs.get(id))), from, to, before || null);
      },

      removed(id) {
        if (!(observeCallbacks.removedAt || observeCallbacks.removed)) {
          return;
        } // technically maybe there should be an EJSON.clone here, but it's about
        // to be removed from this.docs!


        const doc = transform(this.docs.get(id));

        if (observeCallbacks.removedAt) {
          observeCallbacks.removedAt(doc, indices ? this.docs.indexOf(id) : -1);
        } else {
          observeCallbacks.removed(doc);
        }
      }

    };
  } else {
    observeChangesCallbacks = {
      added(id, fields) {
        if (!suppressed && observeCallbacks.added) {
          observeCallbacks.added(transform(Object.assign(fields, {
            _id: id
          })));
        }
      },

      changed(id, fields) {
        if (observeCallbacks.changed) {
          const oldDoc = this.docs.get(id);
          const doc = EJSON.clone(oldDoc);
          DiffSequence.applyChanges(doc, fields);
          observeCallbacks.changed(transform(doc), transform(EJSON.clone(oldDoc)));
        }
      },

      removed(id) {
        if (observeCallbacks.removed) {
          observeCallbacks.removed(transform(this.docs.get(id)));
        }
      }

    };
  }

  const changeObserver = new LocalCollection._CachingChangeObserver({
    callbacks: observeChangesCallbacks
  }); // CachingChangeObserver clones all received input on its callbacks
  // So we can mark it as safe to reduce the ejson clones.
  // This is tested by the `mongo-livedata - (extended) scribbling` tests

  changeObserver.applyChange._fromObserve = true;
  const handle = cursor.observeChanges(changeObserver.applyChange, {
    nonMutatingCallbacks: true
  });
  suppressed = false;
  return handle;
};

LocalCollection._observeCallbacksAreOrdered = callbacks => {
  if (callbacks.added && callbacks.addedAt) {
    throw new Error('Please specify only one of added() and addedAt()');
  }

  if (callbacks.changed && callbacks.changedAt) {
    throw new Error('Please specify only one of changed() and changedAt()');
  }

  if (callbacks.removed && callbacks.removedAt) {
    throw new Error('Please specify only one of removed() and removedAt()');
  }

  return !!(callbacks.addedAt || callbacks.changedAt || callbacks.movedTo || callbacks.removedAt);
};

LocalCollection._observeChangesCallbacksAreOrdered = callbacks => {
  if (callbacks.added && callbacks.addedBefore) {
    throw new Error('Please specify only one of added() and addedBefore()');
  }

  return !!(callbacks.addedBefore || callbacks.movedBefore);
};

LocalCollection._removeFromResults = (query, doc) => {
  if (query.ordered) {
    const i = LocalCollection._findInOrderedResults(query, doc);

    query.removed(doc._id);
    query.results.splice(i, 1);
  } else {
    const id = doc._id; // in case callback mutates doc

    query.removed(doc._id);
    query.results.remove(id);
  }
}; // Is this selector just shorthand for lookup by _id?


LocalCollection._selectorIsId = selector => typeof selector === 'number' || typeof selector === 'string' || selector instanceof MongoID.ObjectID; // Is the selector just lookup by _id (shorthand or not)?


LocalCollection._selectorIsIdPerhapsAsObject = selector => LocalCollection._selectorIsId(selector) || LocalCollection._selectorIsId(selector && selector._id) && Object.keys(selector).length === 1;

LocalCollection._updateInResults = (query, doc, old_doc) => {
  if (!EJSON.equals(doc._id, old_doc._id)) {
    throw new Error('Can\'t change a doc\'s _id while updating');
  }

  const projectionFn = query.projectionFn;
  const changedFields = DiffSequence.makeChangedFields(projectionFn(doc), projectionFn(old_doc));

  if (!query.ordered) {
    if (Object.keys(changedFields).length) {
      query.changed(doc._id, changedFields);
      query.results.set(doc._id, doc);
    }

    return;
  }

  const old_idx = LocalCollection._findInOrderedResults(query, doc);

  if (Object.keys(changedFields).length) {
    query.changed(doc._id, changedFields);
  }

  if (!query.sorter) {
    return;
  } // just take it out and put it back in again, and see if the index changes


  query.results.splice(old_idx, 1);

  const new_idx = LocalCollection._insertInSortedList(query.sorter.getComparator({
    distances: query.distances
  }), query.results, doc);

  if (old_idx !== new_idx) {
    let next = query.results[new_idx + 1];

    if (next) {
      next = next._id;
    } else {
      next = null;
    }

    query.movedBefore && query.movedBefore(doc._id, next);
  }
};

const MODIFIERS = {
  $currentDate(target, field, arg) {
    if (typeof arg === 'object' && hasOwn.call(arg, '$type')) {
      if (arg.$type !== 'date') {
        throw MinimongoError('Minimongo does currently only support the date type in ' + '$currentDate modifiers', {
          field
        });
      }
    } else if (arg !== true) {
      throw MinimongoError('Invalid $currentDate modifier', {
        field
      });
    }

    target[field] = new Date();
  },

  $inc(target, field, arg) {
    if (typeof arg !== 'number') {
      throw MinimongoError('Modifier $inc allowed for numbers only', {
        field
      });
    }

    if (field in target) {
      if (typeof target[field] !== 'number') {
        throw MinimongoError('Cannot apply $inc modifier to non-number', {
          field
        });
      }

      target[field] += arg;
    } else {
      target[field] = arg;
    }
  },

  $min(target, field, arg) {
    if (typeof arg !== 'number') {
      throw MinimongoError('Modifier $min allowed for numbers only', {
        field
      });
    }

    if (field in target) {
      if (typeof target[field] !== 'number') {
        throw MinimongoError('Cannot apply $min modifier to non-number', {
          field
        });
      }

      if (target[field] > arg) {
        target[field] = arg;
      }
    } else {
      target[field] = arg;
    }
  },

  $max(target, field, arg) {
    if (typeof arg !== 'number') {
      throw MinimongoError('Modifier $max allowed for numbers only', {
        field
      });
    }

    if (field in target) {
      if (typeof target[field] !== 'number') {
        throw MinimongoError('Cannot apply $max modifier to non-number', {
          field
        });
      }

      if (target[field] < arg) {
        target[field] = arg;
      }
    } else {
      target[field] = arg;
    }
  },

  $mul(target, field, arg) {
    if (typeof arg !== 'number') {
      throw MinimongoError('Modifier $mul allowed for numbers only', {
        field
      });
    }

    if (field in target) {
      if (typeof target[field] !== 'number') {
        throw MinimongoError('Cannot apply $mul modifier to non-number', {
          field
        });
      }

      target[field] *= arg;
    } else {
      target[field] = 0;
    }
  },

  $rename(target, field, arg, keypath, doc) {
    // no idea why mongo has this restriction..
    if (keypath === arg) {
      throw MinimongoError('$rename source must differ from target', {
        field
      });
    }

    if (target === null) {
      throw MinimongoError('$rename source field invalid', {
        field
      });
    }

    if (typeof arg !== 'string') {
      throw MinimongoError('$rename target must be a string', {
        field
      });
    }

    if (arg.includes('\0')) {
      // Null bytes are not allowed in Mongo field names
      // https://docs.mongodb.com/manual/reference/limits/#Restrictions-on-Field-Names
      throw MinimongoError('The \'to\' field for $rename cannot contain an embedded null byte', {
        field
      });
    }

    if (target === undefined) {
      return;
    }

    const object = target[field];
    delete target[field];
    const keyparts = arg.split('.');
    const target2 = findModTarget(doc, keyparts, {
      forbidArray: true
    });

    if (target2 === null) {
      throw MinimongoError('$rename target field invalid', {
        field
      });
    }

    target2[keyparts.pop()] = object;
  },

  $set(target, field, arg) {
    if (target !== Object(target)) {
      // not an array or an object
      const error = MinimongoError('Cannot set property on non-object field', {
        field
      });
      error.setPropertyError = true;
      throw error;
    }

    if (target === null) {
      const error = MinimongoError('Cannot set property on null', {
        field
      });
      error.setPropertyError = true;
      throw error;
    }

    assertHasValidFieldNames(arg);
    target[field] = arg;
  },

  $setOnInsert(target, field, arg) {// converted to `$set` in `_modify`
  },

  $unset(target, field, arg) {
    if (target !== undefined) {
      if (target instanceof Array) {
        if (field in target) {
          target[field] = null;
        }
      } else {
        delete target[field];
      }
    }
  },

  $push(target, field, arg) {
    if (target[field] === undefined) {
      target[field] = [];
    }

    if (!(target[field] instanceof Array)) {
      throw MinimongoError('Cannot apply $push modifier to non-array', {
        field
      });
    }

    if (!(arg && arg.$each)) {
      // Simple mode: not $each
      assertHasValidFieldNames(arg);
      target[field].push(arg);
      return;
    } // Fancy mode: $each (and maybe $slice and $sort and $position)


    const toPush = arg.$each;

    if (!(toPush instanceof Array)) {
      throw MinimongoError('$each must be an array', {
        field
      });
    }

    assertHasValidFieldNames(toPush); // Parse $position

    let position = undefined;

    if ('$position' in arg) {
      if (typeof arg.$position !== 'number') {
        throw MinimongoError('$position must be a numeric value', {
          field
        });
      } // XXX should check to make sure integer


      if (arg.$position < 0) {
        throw MinimongoError('$position in $push must be zero or positive', {
          field
        });
      }

      position = arg.$position;
    } // Parse $slice.


    let slice = undefined;

    if ('$slice' in arg) {
      if (typeof arg.$slice !== 'number') {
        throw MinimongoError('$slice must be a numeric value', {
          field
        });
      } // XXX should check to make sure integer


      slice = arg.$slice;
    } // Parse $sort.


    let sortFunction = undefined;

    if (arg.$sort) {
      if (slice === undefined) {
        throw MinimongoError('$sort requires $slice to be present', {
          field
        });
      } // XXX this allows us to use a $sort whose value is an array, but that's
      // actually an extension of the Node driver, so it won't work
      // server-side. Could be confusing!
      // XXX is it correct that we don't do geo-stuff here?


      sortFunction = new Minimongo.Sorter(arg.$sort).getComparator();
      toPush.forEach(element => {
        if (LocalCollection._f._type(element) !== 3) {
          throw MinimongoError('$push like modifiers using $sort require all elements to be ' + 'objects', {
            field
          });
        }
      });
    } // Actually push.


    if (position === undefined) {
      toPush.forEach(element => {
        target[field].push(element);
      });
    } else {
      const spliceArguments = [position, 0];
      toPush.forEach(element => {
        spliceArguments.push(element);
      });
      target[field].splice(...spliceArguments);
    } // Actually sort.


    if (sortFunction) {
      target[field].sort(sortFunction);
    } // Actually slice.


    if (slice !== undefined) {
      if (slice === 0) {
        target[field] = []; // differs from Array.slice!
      } else if (slice < 0) {
        target[field] = target[field].slice(slice);
      } else {
        target[field] = target[field].slice(0, slice);
      }
    }
  },

  $pushAll(target, field, arg) {
    if (!(typeof arg === 'object' && arg instanceof Array)) {
      throw MinimongoError('Modifier $pushAll/pullAll allowed for arrays only');
    }

    assertHasValidFieldNames(arg);
    const toPush = target[field];

    if (toPush === undefined) {
      target[field] = arg;
    } else if (!(toPush instanceof Array)) {
      throw MinimongoError('Cannot apply $pushAll modifier to non-array', {
        field
      });
    } else {
      toPush.push(...arg);
    }
  },

  $addToSet(target, field, arg) {
    let isEach = false;

    if (typeof arg === 'object') {
      // check if first key is '$each'
      const keys = Object.keys(arg);

      if (keys[0] === '$each') {
        isEach = true;
      }
    }

    const values = isEach ? arg.$each : [arg];
    assertHasValidFieldNames(values);
    const toAdd = target[field];

    if (toAdd === undefined) {
      target[field] = values;
    } else if (!(toAdd instanceof Array)) {
      throw MinimongoError('Cannot apply $addToSet modifier to non-array', {
        field
      });
    } else {
      values.forEach(value => {
        if (toAdd.some(element => LocalCollection._f._equal(value, element))) {
          return;
        }

        toAdd.push(value);
      });
    }
  },

  $pop(target, field, arg) {
    if (target === undefined) {
      return;
    }

    const toPop = target[field];

    if (toPop === undefined) {
      return;
    }

    if (!(toPop instanceof Array)) {
      throw MinimongoError('Cannot apply $pop modifier to non-array', {
        field
      });
    }

    if (typeof arg === 'number' && arg < 0) {
      toPop.splice(0, 1);
    } else {
      toPop.pop();
    }
  },

  $pull(target, field, arg) {
    if (target === undefined) {
      return;
    }

    const toPull = target[field];

    if (toPull === undefined) {
      return;
    }

    if (!(toPull instanceof Array)) {
      throw MinimongoError('Cannot apply $pull/pullAll modifier to non-array', {
        field
      });
    }

    let out;

    if (arg != null && typeof arg === 'object' && !(arg instanceof Array)) {
      // XXX would be much nicer to compile this once, rather than
      // for each document we modify.. but usually we're not
      // modifying that many documents, so we'll let it slide for
      // now
      // XXX Minimongo.Matcher isn't up for the job, because we need
      // to permit stuff like {$pull: {a: {$gt: 4}}}.. something
      // like {$gt: 4} is not normally a complete selector.
      // same issue as $elemMatch possibly?
      const matcher = new Minimongo.Matcher(arg);
      out = toPull.filter(element => !matcher.documentMatches(element).result);
    } else {
      out = toPull.filter(element => !LocalCollection._f._equal(element, arg));
    }

    target[field] = out;
  },

  $pullAll(target, field, arg) {
    if (!(typeof arg === 'object' && arg instanceof Array)) {
      throw MinimongoError('Modifier $pushAll/pullAll allowed for arrays only', {
        field
      });
    }

    if (target === undefined) {
      return;
    }

    const toPull = target[field];

    if (toPull === undefined) {
      return;
    }

    if (!(toPull instanceof Array)) {
      throw MinimongoError('Cannot apply $pull/pullAll modifier to non-array', {
        field
      });
    }

    target[field] = toPull.filter(object => !arg.some(element => LocalCollection._f._equal(object, element)));
  },

  $bit(target, field, arg) {
    // XXX mongo only supports $bit on integers, and we only support
    // native javascript numbers (doubles) so far, so we can't support $bit
    throw MinimongoError('$bit is not supported', {
      field
    });
  },

  $v() {// As discussed in https://github.com/meteor/meteor/issues/9623,
    // the `$v` operator is not needed by Meteor, but problems can occur if
    // it's not at least callable (as of Mongo >= 3.6). It's defined here as
    // a no-op to work around these problems.
  }

};
const NO_CREATE_MODIFIERS = {
  $pop: true,
  $pull: true,
  $pullAll: true,
  $rename: true,
  $unset: true
}; // Make sure field names do not contain Mongo restricted
// characters ('.', '$', '\0').
// https://docs.mongodb.com/manual/reference/limits/#Restrictions-on-Field-Names

const invalidCharMsg = {
  $: 'start with \'$\'',
  '.': 'contain \'.\'',
  '\0': 'contain null bytes'
}; // checks if all field names in an object are valid

function assertHasValidFieldNames(doc) {
  if (doc && typeof doc === 'object') {
    JSON.stringify(doc, (key, value) => {
      assertIsValidFieldName(key);
      return value;
    });
  }
}

function assertIsValidFieldName(key) {
  let match;

  if (typeof key === 'string' && (match = key.match(/^\$|\.|\0/))) {
    throw MinimongoError("Key ".concat(key, " must not ").concat(invalidCharMsg[match[0]]));
  }
} // for a.b.c.2.d.e, keyparts should be ['a', 'b', 'c', '2', 'd', 'e'],
// and then you would operate on the 'e' property of the returned
// object.
//
// if options.noCreate is falsey, creates intermediate levels of
// structure as necessary, like mkdir -p (and raises an exception if
// that would mean giving a non-numeric property to an array.) if
// options.noCreate is true, return undefined instead.
//
// may modify the last element of keyparts to signal to the caller that it needs
// to use a different value to index into the returned object (for example,
// ['a', '01'] -> ['a', 1]).
//
// if forbidArray is true, return null if the keypath goes through an array.
//
// if options.arrayIndices is set, use its first element for the (first) '$' in
// the path.


function findModTarget(doc, keyparts) {
  let options = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : {};
  let usedArrayIndex = false;

  for (let i = 0; i < keyparts.length; i++) {
    const last = i === keyparts.length - 1;
    let keypart = keyparts[i];

    if (!isIndexable(doc)) {
      if (options.noCreate) {
        return undefined;
      }

      const error = MinimongoError("cannot use the part '".concat(keypart, "' to traverse ").concat(doc));
      error.setPropertyError = true;
      throw error;
    }

    if (doc instanceof Array) {
      if (options.forbidArray) {
        return null;
      }

      if (keypart === '$') {
        if (usedArrayIndex) {
          throw MinimongoError('Too many positional (i.e. \'$\') elements');
        }

        if (!options.arrayIndices || !options.arrayIndices.length) {
          throw MinimongoError('The positional operator did not find the match needed from the ' + 'query');
        }

        keypart = options.arrayIndices[0];
        usedArrayIndex = true;
      } else if (isNumericKey(keypart)) {
        keypart = parseInt(keypart);
      } else {
        if (options.noCreate) {
          return undefined;
        }

        throw MinimongoError("can't append to array using string field name [".concat(keypart, "]"));
      }

      if (last) {
        keyparts[i] = keypart; // handle 'a.01'
      }

      if (options.noCreate && keypart >= doc.length) {
        return undefined;
      }

      while (doc.length < keypart) {
        doc.push(null);
      }

      if (!last) {
        if (doc.length === keypart) {
          doc.push({});
        } else if (typeof doc[keypart] !== 'object') {
          throw MinimongoError("can't modify field '".concat(keyparts[i + 1], "' of list value ") + JSON.stringify(doc[keypart]));
        }
      }
    } else {
      assertIsValidFieldName(keypart);

      if (!(keypart in doc)) {
        if (options.noCreate) {
          return undefined;
        }

        if (!last) {
          doc[keypart] = {};
        }
      }
    }

    if (last) {
      return doc;
    }

    doc = doc[keypart];
  } // notreached

}
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"matcher.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/minimongo/matcher.js                                                                                       //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
var _Package$mongoDecima;

module.export({
  default: () => Matcher
});
let LocalCollection;
module.link("./local_collection.js", {
  default(v) {
    LocalCollection = v;
  }

}, 0);
let compileDocumentSelector, hasOwn, nothingMatcher;
module.link("./common.js", {
  compileDocumentSelector(v) {
    compileDocumentSelector = v;
  },

  hasOwn(v) {
    hasOwn = v;
  },

  nothingMatcher(v) {
    nothingMatcher = v;
  }

}, 1);
const Decimal = ((_Package$mongoDecima = Package['mongo-decimal']) === null || _Package$mongoDecima === void 0 ? void 0 : _Package$mongoDecima.Decimal) || class DecimalStub {}; // The minimongo selector compiler!
// Terminology:
//  - a 'selector' is the EJSON object representing a selector
//  - a 'matcher' is its compiled form (whether a full Minimongo.Matcher
//    object or one of the component lambdas that matches parts of it)
//  - a 'result object' is an object with a 'result' field and maybe
//    distance and arrayIndices.
//  - a 'branched value' is an object with a 'value' field and maybe
//    'dontIterate' and 'arrayIndices'.
//  - a 'document' is a top-level object that can be stored in a collection.
//  - a 'lookup function' is a function that takes in a document and returns
//    an array of 'branched values'.
//  - a 'branched matcher' maps from an array of branched values to a result
//    object.
//  - an 'element matcher' maps from a single value to a bool.
// Main entry point.
//   var matcher = new Minimongo.Matcher({a: {$gt: 5}});
//   if (matcher.documentMatches({a: 7})) ...

class Matcher {
  constructor(selector, isUpdate) {
    // A set (object mapping string -> *) of all of the document paths looked
    // at by the selector. Also includes the empty string if it may look at any
    // path (eg, $where).
    this._paths = {}; // Set to true if compilation finds a $near.

    this._hasGeoQuery = false; // Set to true if compilation finds a $where.

    this._hasWhere = false; // Set to false if compilation finds anything other than a simple equality
    // or one or more of '$gt', '$gte', '$lt', '$lte', '$ne', '$in', '$nin' used
    // with scalars as operands.

    this._isSimple = true; // Set to a dummy document which always matches this Matcher. Or set to null
    // if such document is too hard to find.

    this._matchingDocument = undefined; // A clone of the original selector. It may just be a function if the user
    // passed in a function; otherwise is definitely an object (eg, IDs are
    // translated into {_id: ID} first. Used by canBecomeTrueByModifier and
    // Sorter._useWithMatcher.

    this._selector = null;
    this._docMatcher = this._compileSelector(selector); // Set to true if selection is done for an update operation
    // Default is false
    // Used for $near array update (issue #3599)

    this._isUpdate = isUpdate;
  }

  documentMatches(doc) {
    if (doc !== Object(doc)) {
      throw Error('documentMatches needs a document');
    }

    return this._docMatcher(doc);
  }

  hasGeoQuery() {
    return this._hasGeoQuery;
  }

  hasWhere() {
    return this._hasWhere;
  }

  isSimple() {
    return this._isSimple;
  } // Given a selector, return a function that takes one argument, a
  // document. It returns a result object.


  _compileSelector(selector) {
    // you can pass a literal function instead of a selector
    if (selector instanceof Function) {
      this._isSimple = false;
      this._selector = selector;

      this._recordPathUsed('');

      return doc => ({
        result: !!selector.call(doc)
      });
    } // shorthand -- scalar _id


    if (LocalCollection._selectorIsId(selector)) {
      this._selector = {
        _id: selector
      };

      this._recordPathUsed('_id');

      return doc => ({
        result: EJSON.equals(doc._id, selector)
      });
    } // protect against dangerous selectors.  falsey and {_id: falsey} are both
    // likely programmer error, and not what you want, particularly for
    // destructive operations.


    if (!selector || hasOwn.call(selector, '_id') && !selector._id) {
      this._isSimple = false;
      return nothingMatcher;
    } // Top level can't be an array or true or binary.


    if (Array.isArray(selector) || EJSON.isBinary(selector) || typeof selector === 'boolean') {
      throw new Error("Invalid selector: ".concat(selector));
    }

    this._selector = EJSON.clone(selector);
    return compileDocumentSelector(selector, this, {
      isRoot: true
    });
  } // Returns a list of key paths the given selector is looking for. It includes
  // the empty string if there is a $where.


  _getPaths() {
    return Object.keys(this._paths);
  }

  _recordPathUsed(path) {
    this._paths[path] = true;
  }

}

// helpers used by compiled selector code
LocalCollection._f = {
  // XXX for _all and _in, consider building 'inquery' at compile time..
  _type(v) {
    if (typeof v === 'number') {
      return 1;
    }

    if (typeof v === 'string') {
      return 2;
    }

    if (typeof v === 'boolean') {
      return 8;
    }

    if (Array.isArray(v)) {
      return 4;
    }

    if (v === null) {
      return 10;
    } // note that typeof(/x/) === "object"


    if (v instanceof RegExp) {
      return 11;
    }

    if (typeof v === 'function') {
      return 13;
    }

    if (v instanceof Date) {
      return 9;
    }

    if (EJSON.isBinary(v)) {
      return 5;
    }

    if (v instanceof MongoID.ObjectID) {
      return 7;
    }

    if (v instanceof Decimal) {
      return 1;
    } // object


    return 3; // XXX support some/all of these:
    // 14, symbol
    // 15, javascript code with scope
    // 16, 18: 32-bit/64-bit integer
    // 17, timestamp
    // 255, minkey
    // 127, maxkey
  },

  // deep equality test: use for literal document and array matches
  _equal(a, b) {
    return EJSON.equals(a, b, {
      keyOrderSensitive: true
    });
  },

  // maps a type code to a value that can be used to sort values of different
  // types
  _typeorder(t) {
    // http://www.mongodb.org/display/DOCS/What+is+the+Compare+Order+for+BSON+Types
    // XXX what is the correct sort position for Javascript code?
    // ('100' in the matrix below)
    // XXX minkey/maxkey
    return [-1, // (not a type)
    1, // number
    2, // string
    3, // object
    4, // array
    5, // binary
    -1, // deprecated
    6, // ObjectID
    7, // bool
    8, // Date
    0, // null
    9, // RegExp
    -1, // deprecated
    100, // JS code
    2, // deprecated (symbol)
    100, // JS code
    1, // 32-bit int
    8, // Mongo timestamp
    1 // 64-bit int
    ][t];
  },

  // compare two values of unknown type according to BSON ordering
  // semantics. (as an extension, consider 'undefined' to be less than
  // any other value.) return negative if a is less, positive if b is
  // less, or 0 if equal
  _cmp(a, b) {
    if (a === undefined) {
      return b === undefined ? 0 : -1;
    }

    if (b === undefined) {
      return 1;
    }

    let ta = LocalCollection._f._type(a);

    let tb = LocalCollection._f._type(b);

    const oa = LocalCollection._f._typeorder(ta);

    const ob = LocalCollection._f._typeorder(tb);

    if (oa !== ob) {
      return oa < ob ? -1 : 1;
    } // XXX need to implement this if we implement Symbol or integers, or
    // Timestamp


    if (ta !== tb) {
      throw Error('Missing type coercion logic in _cmp');
    }

    if (ta === 7) {
      // ObjectID
      // Convert to string.
      ta = tb = 2;
      a = a.toHexString();
      b = b.toHexString();
    }

    if (ta === 9) {
      // Date
      // Convert to millis.
      ta = tb = 1;
      a = isNaN(a) ? 0 : a.getTime();
      b = isNaN(b) ? 0 : b.getTime();
    }

    if (ta === 1) {
      // double
      if (a instanceof Decimal) {
        return a.minus(b).toNumber();
      } else {
        return a - b;
      }
    }

    if (tb === 2) // string
      return a < b ? -1 : a === b ? 0 : 1;

    if (ta === 3) {
      // Object
      // this could be much more efficient in the expected case ...
      const toArray = object => {
        const result = [];
        Object.keys(object).forEach(key => {
          result.push(key, object[key]);
        });
        return result;
      };

      return LocalCollection._f._cmp(toArray(a), toArray(b));
    }

    if (ta === 4) {
      // Array
      for (let i = 0;; i++) {
        if (i === a.length) {
          return i === b.length ? 0 : -1;
        }

        if (i === b.length) {
          return 1;
        }

        const s = LocalCollection._f._cmp(a[i], b[i]);

        if (s !== 0) {
          return s;
        }
      }
    }

    if (ta === 5) {
      // binary
      // Surprisingly, a small binary blob is always less than a large one in
      // Mongo.
      if (a.length !== b.length) {
        return a.length - b.length;
      }

      for (let i = 0; i < a.length; i++) {
        if (a[i] < b[i]) {
          return -1;
        }

        if (a[i] > b[i]) {
          return 1;
        }
      }

      return 0;
    }

    if (ta === 8) {
      // boolean
      if (a) {
        return b ? 0 : 1;
      }

      return b ? -1 : 0;
    }

    if (ta === 10) // null
      return 0;
    if (ta === 11) // regexp
      throw Error('Sorting not supported on regular expression'); // XXX
    // 13: javascript code
    // 14: symbol
    // 15: javascript code with scope
    // 16: 32-bit integer
    // 17: timestamp
    // 18: 64-bit integer
    // 255: minkey
    // 127: maxkey

    if (ta === 13) // javascript code
      throw Error('Sorting not supported on Javascript code'); // XXX

    throw Error('Unknown type to sort');
  }

};
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"minimongo_common.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/minimongo/minimongo_common.js                                                                              //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
let LocalCollection_;
module.link("./local_collection.js", {
  default(v) {
    LocalCollection_ = v;
  }

}, 0);
let Matcher;
module.link("./matcher.js", {
  default(v) {
    Matcher = v;
  }

}, 1);
let Sorter;
module.link("./sorter.js", {
  default(v) {
    Sorter = v;
  }

}, 2);
LocalCollection = LocalCollection_;
Minimongo = {
  LocalCollection: LocalCollection_,
  Matcher,
  Sorter
};
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"observe_handle.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/minimongo/observe_handle.js                                                                                //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
module.export({
  default: () => ObserveHandle
});

class ObserveHandle {}
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

},"sorter.js":function module(require,exports,module){

/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
//                                                                                                                     //
// packages/minimongo/sorter.js                                                                                        //
//                                                                                                                     //
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
                                                                                                                       //
module.export({
  default: () => Sorter
});
let ELEMENT_OPERATORS, equalityElementMatcher, expandArraysInBranches, hasOwn, isOperatorObject, makeLookupFunction, regexpElementMatcher;
module.link("./common.js", {
  ELEMENT_OPERATORS(v) {
    ELEMENT_OPERATORS = v;
  },

  equalityElementMatcher(v) {
    equalityElementMatcher = v;
  },

  expandArraysInBranches(v) {
    expandArraysInBranches = v;
  },

  hasOwn(v) {
    hasOwn = v;
  },

  isOperatorObject(v) {
    isOperatorObject = v;
  },

  makeLookupFunction(v) {
    makeLookupFunction = v;
  },

  regexpElementMatcher(v) {
    regexpElementMatcher = v;
  }

}, 0);

class Sorter {
  constructor(spec) {
    this._sortSpecParts = [];
    this._sortFunction = null;

    const addSpecPart = (path, ascending) => {
      if (!path) {
        throw Error('sort keys must be non-empty');
      }

      if (path.charAt(0) === '$') {
        throw Error("unsupported sort key: ".concat(path));
      }

      this._sortSpecParts.push({
        ascending,
        lookup: makeLookupFunction(path, {
          forSort: true
        }),
        path
      });
    };

    if (spec instanceof Array) {
      spec.forEach(element => {
        if (typeof element === 'string') {
          addSpecPart(element, true);
        } else {
          addSpecPart(element[0], element[1] !== 'desc');
        }
      });
    } else if (typeof spec === 'object') {
      Object.keys(spec).forEach(key => {
        addSpecPart(key, spec[key] >= 0);
      });
    } else if (typeof spec === 'function') {
      this._sortFunction = spec;
    } else {
      throw Error("Bad sort specification: ".concat(JSON.stringify(spec)));
    } // If a function is specified for sorting, we skip the rest.


    if (this._sortFunction) {
      return;
    } // To implement affectedByModifier, we piggy-back on top of Matcher's
    // affectedByModifier code; we create a selector that is affected by the
    // same modifiers as this sort order. This is only implemented on the
    // server.


    if (this.affectedByModifier) {
      const selector = {};

      this._sortSpecParts.forEach(spec => {
        selector[spec.path] = 1;
      });

      this._selectorForAffectedByModifier = new Minimongo.Matcher(selector);
    }

    this._keyComparator = composeComparators(this._sortSpecParts.map((spec, i) => this._keyFieldComparator(i)));
  }

  getComparator(options) {
    // If sort is specified or have no distances, just use the comparator from
    // the source specification (which defaults to "everything is equal".
    // issue #3599
    // https://docs.mongodb.com/manual/reference/operator/query/near/#sort-operation
    // sort effectively overrides $near
    if (this._sortSpecParts.length || !options || !options.distances) {
      return this._getBaseComparator();
    }

    const distances = options.distances; // Return a comparator which compares using $near distances.

    return (a, b) => {
      if (!distances.has(a._id)) {
        throw Error("Missing distance for ".concat(a._id));
      }

      if (!distances.has(b._id)) {
        throw Error("Missing distance for ".concat(b._id));
      }

      return distances.get(a._id) - distances.get(b._id);
    };
  } // Takes in two keys: arrays whose lengths match the number of spec
  // parts. Returns negative, 0, or positive based on using the sort spec to
  // compare fields.


  _compareKeys(key1, key2) {
    if (key1.length !== this._sortSpecParts.length || key2.length !== this._sortSpecParts.length) {
      throw Error('Key has wrong length');
    }

    return this._keyComparator(key1, key2);
  } // Iterates over each possible "key" from doc (ie, over each branch), calling
  // 'cb' with the key.


  _generateKeysFromDoc(doc, cb) {
    if (this._sortSpecParts.length === 0) {
      throw new Error('can\'t generate keys without a spec');
    }

    const pathFromIndices = indices => "".concat(indices.join(','), ",");

    let knownPaths = null; // maps index -> ({'' -> value} or {path -> value})

    const valuesByIndexAndPath = this._sortSpecParts.map(spec => {
      // Expand any leaf arrays that we find, and ignore those arrays
      // themselves.  (We never sort based on an array itself.)
      let branches = expandArraysInBranches(spec.lookup(doc), true); // If there are no values for a key (eg, key goes to an empty array),
      // pretend we found one undefined value.

      if (!branches.length) {
        branches = [{
          value: void 0
        }];
      }

      const element = Object.create(null);
      let usedPaths = false;
      branches.forEach(branch => {
        if (!branch.arrayIndices) {
          // If there are no array indices for a branch, then it must be the
          // only branch, because the only thing that produces multiple branches
          // is the use of arrays.
          if (branches.length > 1) {
            throw Error('multiple branches but no array used?');
          }

          element[''] = branch.value;
          return;
        }

        usedPaths = true;
        const path = pathFromIndices(branch.arrayIndices);

        if (hasOwn.call(element, path)) {
          throw Error("duplicate path: ".concat(path));
        }

        element[path] = branch.value; // If two sort fields both go into arrays, they have to go into the
        // exact same arrays and we have to find the same paths.  This is
        // roughly the same condition that makes MongoDB throw this strange
        // error message.  eg, the main thing is that if sort spec is {a: 1,
        // b:1} then a and b cannot both be arrays.
        //
        // (In MongoDB it seems to be OK to have {a: 1, 'a.x.y': 1} where 'a'
        // and 'a.x.y' are both arrays, but we don't allow this for now.
        // #NestedArraySort
        // XXX achieve full compatibility here

        if (knownPaths && !hasOwn.call(knownPaths, path)) {
          throw Error('cannot index parallel arrays');
        }
      });

      if (knownPaths) {
        // Similarly to above, paths must match everywhere, unless this is a
        // non-array field.
        if (!hasOwn.call(element, '') && Object.keys(knownPaths).length !== Object.keys(element).length) {
          throw Error('cannot index parallel arrays!');
        }
      } else if (usedPaths) {
        knownPaths = {};
        Object.keys(element).forEach(path => {
          knownPaths[path] = true;
        });
      }

      return element;
    });

    if (!knownPaths) {
      // Easy case: no use of arrays.
      const soleKey = valuesByIndexAndPath.map(values => {
        if (!hasOwn.call(values, '')) {
          throw Error('no value in sole key case?');
        }

        return values[''];
      });
      cb(soleKey);
      return;
    }

    Object.keys(knownPaths).forEach(path => {
      const key = valuesByIndexAndPath.map(values => {
        if (hasOwn.call(values, '')) {
          return values[''];
        }

        if (!hasOwn.call(values, path)) {
          throw Error('missing path?');
        }

        return values[path];
      });
      cb(key);
    });
  } // Returns a comparator that represents the sort specification (but not
  // including a possible geoquery distance tie-breaker).


  _getBaseComparator() {
    if (this._sortFunction) {
      return this._sortFunction;
    } // If we're only sorting on geoquery distance and no specs, just say
    // everything is equal.


    if (!this._sortSpecParts.length) {
      return (doc1, doc2) => 0;
    }

    return (doc1, doc2) => {
      const key1 = this._getMinKeyFromDoc(doc1);

      const key2 = this._getMinKeyFromDoc(doc2);

      return this._compareKeys(key1, key2);
    };
  } // Finds the minimum key from the doc, according to the sort specs.  (We say
  // "minimum" here but this is with respect to the sort spec, so "descending"
  // sort fields mean we're finding the max for that field.)
  //
  // Note that this is NOT "find the minimum value of the first field, the
  // minimum value of the second field, etc"... it's "choose the
  // lexicographically minimum value of the key vector, allowing only keys which
  // you can find along the same paths".  ie, for a doc {a: [{x: 0, y: 5}, {x:
  // 1, y: 3}]} with sort spec {'a.x': 1, 'a.y': 1}, the only keys are [0,5] and
  // [1,3], and the minimum key is [0,5]; notably, [0,3] is NOT a key.


  _getMinKeyFromDoc(doc) {
    let minKey = null;

    this._generateKeysFromDoc(doc, key => {
      if (minKey === null) {
        minKey = key;
        return;
      }

      if (this._compareKeys(key, minKey) < 0) {
        minKey = key;
      }
    });

    return minKey;
  }

  _getPaths() {
    return this._sortSpecParts.map(part => part.path);
  } // Given an index 'i', returns a comparator that compares two key arrays based
  // on field 'i'.


  _keyFieldComparator(i) {
    const invert = !this._sortSpecParts[i].ascending;
    return (key1, key2) => {
      const compare = LocalCollection._f._cmp(key1[i], key2[i]);

      return invert ? -compare : compare;
    };
  }

}

// Given an array of comparators
// (functions (a,b)->(negative or positive or zero)), returns a single
// comparator which uses each comparator in order and returns the first
// non-zero value.
function composeComparators(comparatorArray) {
  return (a, b) => {
    for (let i = 0; i < comparatorArray.length; ++i) {
      const compare = comparatorArray[i](a, b);

      if (compare !== 0) {
        return compare;
      }
    }

    return 0;
  };
}
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

}}}}},{
  "extensions": [
    ".js",
    ".json"
  ]
});

var exports = require("/node_modules/meteor/minimongo/minimongo_server.js");

/* Exports */
Package._define("minimongo", exports, {
  LocalCollection: LocalCollection,
  Minimongo: Minimongo,
  MinimongoTest: MinimongoTest,
  MinimongoError: MinimongoError
});

})();

//# sourceURL=meteor://💻app/packages/minimongo.js
//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIm1ldGVvcjovL/CfkrthcHAvcGFja2FnZXMvbWluaW1vbmdvL21pbmltb25nb19zZXJ2ZXIuanMiLCJtZXRlb3I6Ly/wn5K7YXBwL3BhY2thZ2VzL21pbmltb25nby9jb21tb24uanMiLCJtZXRlb3I6Ly/wn5K7YXBwL3BhY2thZ2VzL21pbmltb25nby9jb25zdGFudHMuanMiLCJtZXRlb3I6Ly/wn5K7YXBwL3BhY2thZ2VzL21pbmltb25nby9jdXJzb3IuanMiLCJtZXRlb3I6Ly/wn5K7YXBwL3BhY2thZ2VzL21pbmltb25nby9sb2NhbF9jb2xsZWN0aW9uLmpzIiwibWV0ZW9yOi8v8J+Su2FwcC9wYWNrYWdlcy9taW5pbW9uZ28vbWF0Y2hlci5qcyIsIm1ldGVvcjovL/CfkrthcHAvcGFja2FnZXMvbWluaW1vbmdvL21pbmltb25nb19jb21tb24uanMiLCJtZXRlb3I6Ly/wn5K7YXBwL3BhY2thZ2VzL21pbmltb25nby9vYnNlcnZlX2hhbmRsZS5qcyIsIm1ldGVvcjovL/CfkrthcHAvcGFja2FnZXMvbWluaW1vbmdvL3NvcnRlci5qcyJdLCJuYW1lcyI6WyJtb2R1bGUiLCJsaW5rIiwiaGFzT3duIiwiaXNOdW1lcmljS2V5IiwiaXNPcGVyYXRvck9iamVjdCIsInBhdGhzVG9UcmVlIiwicHJvamVjdGlvbkRldGFpbHMiLCJ2IiwiTWluaW1vbmdvIiwiX3BhdGhzRWxpZGluZ051bWVyaWNLZXlzIiwicGF0aHMiLCJtYXAiLCJwYXRoIiwic3BsaXQiLCJmaWx0ZXIiLCJwYXJ0Iiwiam9pbiIsIk1hdGNoZXIiLCJwcm90b3R5cGUiLCJhZmZlY3RlZEJ5TW9kaWZpZXIiLCJtb2RpZmllciIsIk9iamVjdCIsImFzc2lnbiIsIiRzZXQiLCIkdW5zZXQiLCJtZWFuaW5nZnVsUGF0aHMiLCJfZ2V0UGF0aHMiLCJtb2RpZmllZFBhdGhzIiwiY29uY2F0Iiwia2V5cyIsInNvbWUiLCJtb2QiLCJtZWFuaW5nZnVsUGF0aCIsInNlbCIsImkiLCJqIiwibGVuZ3RoIiwiY2FuQmVjb21lVHJ1ZUJ5TW9kaWZpZXIiLCJpc1NpbXBsZSIsIm1vZGlmaWVyUGF0aHMiLCJwYXRoSGFzTnVtZXJpY0tleXMiLCJleHBlY3RlZFNjYWxhcklzT2JqZWN0IiwiX3NlbGVjdG9yIiwibW9kaWZpZXJQYXRoIiwic3RhcnRzV2l0aCIsIm1hdGNoaW5nRG9jdW1lbnQiLCJFSlNPTiIsImNsb25lIiwiTG9jYWxDb2xsZWN0aW9uIiwiX21vZGlmeSIsImVycm9yIiwibmFtZSIsInNldFByb3BlcnR5RXJyb3IiLCJkb2N1bWVudE1hdGNoZXMiLCJyZXN1bHQiLCJjb21iaW5lSW50b1Byb2plY3Rpb24iLCJwcm9qZWN0aW9uIiwic2VsZWN0b3JQYXRocyIsImluY2x1ZGVzIiwiY29tYmluZUltcG9ydGFudFBhdGhzSW50b1Byb2plY3Rpb24iLCJfbWF0Y2hpbmdEb2N1bWVudCIsInVuZGVmaW5lZCIsImZhbGxiYWNrIiwidmFsdWVTZWxlY3RvciIsIiRlcSIsIiRpbiIsIm1hdGNoZXIiLCJwbGFjZWhvbGRlciIsImZpbmQiLCJvbmx5Q29udGFpbnNLZXlzIiwibG93ZXJCb3VuZCIsIkluZmluaXR5IiwidXBwZXJCb3VuZCIsImZvckVhY2giLCJvcCIsImNhbGwiLCJtaWRkbGUiLCJ4IiwiU29ydGVyIiwiX3NlbGVjdG9yRm9yQWZmZWN0ZWRCeU1vZGlmaWVyIiwiZGV0YWlscyIsInRyZWUiLCJub2RlIiwiZnVsbFBhdGgiLCJtZXJnZWRQcm9qZWN0aW9uIiwidHJlZVRvUGF0aHMiLCJpbmNsdWRpbmciLCJtZXJnZWRFeGNsUHJvamVjdGlvbiIsImdldFBhdGhzIiwic2VsZWN0b3IiLCJfcGF0aHMiLCJvYmoiLCJldmVyeSIsImsiLCJwcmVmaXgiLCJrZXkiLCJ2YWx1ZSIsImV4cG9ydCIsIkVMRU1FTlRfT1BFUkFUT1JTIiwiY29tcGlsZURvY3VtZW50U2VsZWN0b3IiLCJlcXVhbGl0eUVsZW1lbnRNYXRjaGVyIiwiZXhwYW5kQXJyYXlzSW5CcmFuY2hlcyIsImlzSW5kZXhhYmxlIiwibWFrZUxvb2t1cEZ1bmN0aW9uIiwibm90aGluZ01hdGNoZXIiLCJwb3B1bGF0ZURvY3VtZW50V2l0aFF1ZXJ5RmllbGRzIiwicmVnZXhwRWxlbWVudE1hdGNoZXIiLCJkZWZhdWx0IiwiaGFzT3duUHJvcGVydHkiLCIkbHQiLCJtYWtlSW5lcXVhbGl0eSIsImNtcFZhbHVlIiwiJGd0IiwiJGx0ZSIsIiRndGUiLCIkbW9kIiwiY29tcGlsZUVsZW1lbnRTZWxlY3RvciIsIm9wZXJhbmQiLCJBcnJheSIsImlzQXJyYXkiLCJFcnJvciIsImRpdmlzb3IiLCJyZW1haW5kZXIiLCJlbGVtZW50TWF0Y2hlcnMiLCJvcHRpb24iLCJSZWdFeHAiLCIkc2l6ZSIsImRvbnRFeHBhbmRMZWFmQXJyYXlzIiwiJHR5cGUiLCJkb250SW5jbHVkZUxlYWZBcnJheXMiLCJvcGVyYW5kQWxpYXNNYXAiLCJfZiIsIl90eXBlIiwiJGJpdHNBbGxTZXQiLCJtYXNrIiwiZ2V0T3BlcmFuZEJpdG1hc2siLCJiaXRtYXNrIiwiZ2V0VmFsdWVCaXRtYXNrIiwiYnl0ZSIsIiRiaXRzQW55U2V0IiwiJGJpdHNBbGxDbGVhciIsIiRiaXRzQW55Q2xlYXIiLCIkcmVnZXgiLCJyZWdleHAiLCIkb3B0aW9ucyIsInRlc3QiLCJzb3VyY2UiLCIkZWxlbU1hdGNoIiwiX2lzUGxhaW5PYmplY3QiLCJpc0RvY01hdGNoZXIiLCJMT0dJQ0FMX09QRVJBVE9SUyIsInJlZHVjZSIsImEiLCJiIiwic3ViTWF0Y2hlciIsImluRWxlbU1hdGNoIiwiY29tcGlsZVZhbHVlU2VsZWN0b3IiLCJhcnJheUVsZW1lbnQiLCJhcmciLCJkb250SXRlcmF0ZSIsIiRhbmQiLCJzdWJTZWxlY3RvciIsImFuZERvY3VtZW50TWF0Y2hlcnMiLCJjb21waWxlQXJyYXlPZkRvY3VtZW50U2VsZWN0b3JzIiwiJG9yIiwibWF0Y2hlcnMiLCJkb2MiLCJmbiIsIiRub3IiLCIkd2hlcmUiLCJzZWxlY3RvclZhbHVlIiwiX3JlY29yZFBhdGhVc2VkIiwiX2hhc1doZXJlIiwiRnVuY3Rpb24iLCIkY29tbWVudCIsIlZBTFVFX09QRVJBVE9SUyIsImNvbnZlcnRFbGVtZW50TWF0Y2hlclRvQnJhbmNoZWRNYXRjaGVyIiwiJG5vdCIsImludmVydEJyYW5jaGVkTWF0Y2hlciIsIiRuZSIsIiRuaW4iLCIkZXhpc3RzIiwiZXhpc3RzIiwiZXZlcnl0aGluZ01hdGNoZXIiLCIkbWF4RGlzdGFuY2UiLCIkbmVhciIsIiRhbGwiLCJicmFuY2hlZE1hdGNoZXJzIiwiY3JpdGVyaW9uIiwiYW5kQnJhbmNoZWRNYXRjaGVycyIsImlzUm9vdCIsIl9oYXNHZW9RdWVyeSIsIm1heERpc3RhbmNlIiwicG9pbnQiLCJkaXN0YW5jZSIsIiRnZW9tZXRyeSIsInR5cGUiLCJHZW9KU09OIiwicG9pbnREaXN0YW5jZSIsImNvb3JkaW5hdGVzIiwicG9pbnRUb0FycmF5IiwiZ2VvbWV0cnlXaXRoaW5SYWRpdXMiLCJkaXN0YW5jZUNvb3JkaW5hdGVQYWlycyIsImJyYW5jaGVkVmFsdWVzIiwiYnJhbmNoIiwiY3VyRGlzdGFuY2UiLCJfaXNVcGRhdGUiLCJhcnJheUluZGljZXMiLCJhbmRTb21lTWF0Y2hlcnMiLCJzdWJNYXRjaGVycyIsImRvY09yQnJhbmNoZXMiLCJtYXRjaCIsInN1YlJlc3VsdCIsInNlbGVjdG9ycyIsImRvY1NlbGVjdG9yIiwib3B0aW9ucyIsImRvY01hdGNoZXJzIiwic3Vic3RyIiwiX2lzU2ltcGxlIiwibG9va1VwQnlJbmRleCIsInZhbHVlTWF0Y2hlciIsIkJvb2xlYW4iLCJvcGVyYXRvckJyYW5jaGVkTWF0Y2hlciIsImVsZW1lbnRNYXRjaGVyIiwiYnJhbmNoZXMiLCJleHBhbmRlZCIsImVsZW1lbnQiLCJtYXRjaGVkIiwicG9pbnRBIiwicG9pbnRCIiwiTWF0aCIsImh5cG90IiwiZWxlbWVudFNlbGVjdG9yIiwiX2VxdWFsIiwiZG9jT3JCcmFuY2hlZFZhbHVlcyIsInNraXBUaGVBcnJheXMiLCJicmFuY2hlc091dCIsInRoaXNJc0FycmF5IiwicHVzaCIsIk51bWJlciIsImlzSW50ZWdlciIsIlVpbnQ4QXJyYXkiLCJJbnQzMkFycmF5IiwiYnVmZmVyIiwiaXNCaW5hcnkiLCJBcnJheUJ1ZmZlciIsIm1heCIsInZpZXciLCJpc1NhZmVJbnRlZ2VyIiwiVWludDMyQXJyYXkiLCJCWVRFU19QRVJfRUxFTUVOVCIsImluc2VydEludG9Eb2N1bWVudCIsImRvY3VtZW50IiwiZXhpc3RpbmdLZXkiLCJpbmRleE9mIiwiYnJhbmNoZWRNYXRjaGVyIiwiYnJhbmNoVmFsdWVzIiwicyIsImluY29uc2lzdGVudE9LIiwidGhlc2VBcmVPcGVyYXRvcnMiLCJzZWxLZXkiLCJ0aGlzSXNPcGVyYXRvciIsIkpTT04iLCJzdHJpbmdpZnkiLCJjbXBWYWx1ZUNvbXBhcmF0b3IiLCJvcGVyYW5kVHlwZSIsIl9jbXAiLCJwYXJ0cyIsImZpcnN0UGFydCIsImxvb2t1cFJlc3QiLCJzbGljZSIsIm9taXRVbm5lY2Vzc2FyeUZpZWxkcyIsImZpcnN0TGV2ZWwiLCJhcHBlbmRUb1Jlc3VsdCIsIm1vcmUiLCJmb3JTb3J0IiwiYXJyYXlJbmRleCIsIk1pbmltb25nb1Rlc3QiLCJNaW5pbW9uZ29FcnJvciIsIm1lc3NhZ2UiLCJmaWVsZCIsIm9wZXJhdG9yTWF0Y2hlcnMiLCJvcGVyYXRvciIsInNpbXBsZVJhbmdlIiwic2ltcGxlRXF1YWxpdHkiLCJzaW1wbGVJbmNsdXNpb24iLCJuZXdMZWFmRm4iLCJjb25mbGljdEZuIiwicm9vdCIsInBhdGhBcnJheSIsInN1Y2Nlc3MiLCJsYXN0S2V5IiwieSIsInBvcHVsYXRlRG9jdW1lbnRXaXRoS2V5VmFsdWUiLCJnZXRQcm90b3R5cGVPZiIsInBvcHVsYXRlRG9jdW1lbnRXaXRoT2JqZWN0IiwidW5wcmVmaXhlZEtleXMiLCJ2YWxpZGF0ZU9iamVjdCIsIm9iamVjdCIsInF1ZXJ5IiwiX3NlbGVjdG9ySXNJZCIsImZpZWxkcyIsImZpZWxkc0tleXMiLCJzb3J0IiwiX2lkIiwia2V5UGF0aCIsInJ1bGUiLCJwcm9qZWN0aW9uUnVsZXNUcmVlIiwiY3VycmVudFBhdGgiLCJhbm90aGVyUGF0aCIsInRvU3RyaW5nIiwibGFzdEluZGV4IiwidmFsaWRhdGVLZXlJblBhdGgiLCJnZXRBc3luY01ldGhvZE5hbWUiLCJBU1lOQ19DT0xMRUNUSU9OX01FVEhPRFMiLCJBU1lOQ19DVVJTT1JfTUVUSE9EUyIsIm1ldGhvZCIsInJlcGxhY2UiLCJDdXJzb3IiLCJjb25zdHJ1Y3RvciIsImNvbGxlY3Rpb24iLCJzb3J0ZXIiLCJfc2VsZWN0b3JJc0lkUGVyaGFwc0FzT2JqZWN0IiwiX3NlbGVjdG9ySWQiLCJoYXNHZW9RdWVyeSIsInNraXAiLCJsaW1pdCIsIl9wcm9qZWN0aW9uRm4iLCJfY29tcGlsZVByb2plY3Rpb24iLCJfdHJhbnNmb3JtIiwid3JhcFRyYW5zZm9ybSIsInRyYW5zZm9ybSIsIlRyYWNrZXIiLCJyZWFjdGl2ZSIsImNvdW50IiwiX2RlcGVuZCIsImFkZGVkIiwicmVtb3ZlZCIsIl9nZXRSYXdPYmplY3RzIiwib3JkZXJlZCIsImZldGNoIiwiU3ltYm9sIiwiaXRlcmF0b3IiLCJhZGRlZEJlZm9yZSIsImNoYW5nZWQiLCJtb3ZlZEJlZm9yZSIsImluZGV4Iiwib2JqZWN0cyIsIm5leHQiLCJkb25lIiwiYXN5bmNJdGVyYXRvciIsInN5bmNSZXN1bHQiLCJQcm9taXNlIiwicmVzb2x2ZSIsImNhbGxiYWNrIiwidGhpc0FyZyIsImdldFRyYW5zZm9ybSIsIm9ic2VydmUiLCJfb2JzZXJ2ZUZyb21PYnNlcnZlQ2hhbmdlcyIsIm9ic2VydmVDaGFuZ2VzIiwiX29ic2VydmVDaGFuZ2VzQ2FsbGJhY2tzQXJlT3JkZXJlZCIsIl9hbGxvd191bm9yZGVyZWQiLCJkaXN0YW5jZXMiLCJfSWRNYXAiLCJjdXJzb3IiLCJkaXJ0eSIsInByb2plY3Rpb25GbiIsInJlc3VsdHNTbmFwc2hvdCIsInFpZCIsIm5leHRfcWlkIiwicXVlcmllcyIsInJlc3VsdHMiLCJwYXVzZWQiLCJ3cmFwQ2FsbGJhY2siLCJzZWxmIiwiYXJncyIsImFyZ3VtZW50cyIsIl9vYnNlcnZlUXVldWUiLCJxdWV1ZVRhc2siLCJhcHBseSIsIl9zdXBwcmVzc19pbml0aWFsIiwiaGFuZGxlIiwiT2JzZXJ2ZUhhbmRsZSIsInN0b3AiLCJhY3RpdmUiLCJvbkludmFsaWRhdGUiLCJkcmFpbiIsImNoYW5nZXJzIiwiZGVwZW5kZW5jeSIsIkRlcGVuZGVuY3kiLCJub3RpZnkiLCJiaW5kIiwiZGVwZW5kIiwiX2dldENvbGxlY3Rpb25OYW1lIiwiYXBwbHlTa2lwTGltaXQiLCJzZWxlY3RlZERvYyIsIl9kb2NzIiwiZ2V0Iiwic2V0IiwiY2xlYXIiLCJpZCIsIm1hdGNoUmVzdWx0IiwiZ2V0Q29tcGFyYXRvciIsIl9wdWJsaXNoQ3Vyc29yIiwic3Vic2NyaXB0aW9uIiwiUGFja2FnZSIsIm1vbmdvIiwiTW9uZ28iLCJDb2xsZWN0aW9uIiwiYXN5bmNOYW1lIiwiX29iamVjdFNwcmVhZCIsIk1ldGVvciIsIl9TeW5jaHJvbm91c1F1ZXVlIiwiY3JlYXRlIiwiX3NhdmVkT3JpZ2luYWxzIiwiZmluZE9uZSIsImluc2VydCIsImFzc2VydEhhc1ZhbGlkRmllbGROYW1lcyIsIl91c2VPSUQiLCJNb25nb0lEIiwiT2JqZWN0SUQiLCJSYW5kb20iLCJoYXMiLCJfc2F2ZU9yaWdpbmFsIiwicXVlcmllc1RvUmVjb21wdXRlIiwiX2luc2VydEluUmVzdWx0cyIsIl9yZWNvbXB1dGVSZXN1bHRzIiwiZGVmZXIiLCJwYXVzZU9ic2VydmVycyIsInJlbW92ZSIsImVxdWFscyIsInNpemUiLCJfZWFjaFBvc3NpYmx5TWF0Y2hpbmdEb2MiLCJxdWVyeVJlbW92ZSIsInJlbW92ZUlkIiwicmVtb3ZlRG9jIiwiX3JlbW92ZUZyb21SZXN1bHRzIiwicmVzdW1lT2JzZXJ2ZXJzIiwiX2RpZmZRdWVyeUNoYW5nZXMiLCJyZXRyaWV2ZU9yaWdpbmFscyIsIm9yaWdpbmFscyIsInNhdmVPcmlnaW5hbHMiLCJ1cGRhdGUiLCJxaWRUb09yaWdpbmFsUmVzdWx0cyIsImRvY01hcCIsImlkc01hdGNoZWQiLCJfaWRzTWF0Y2hlZEJ5U2VsZWN0b3IiLCJtZW1vaXplZENsb25lSWZOZWVkZWQiLCJkb2NUb01lbW9pemUiLCJyZWNvbXB1dGVRaWRzIiwidXBkYXRlQ291bnQiLCJxdWVyeVJlc3VsdCIsIl9tb2RpZnlBbmROb3RpZnkiLCJtdWx0aSIsImluc2VydGVkSWQiLCJ1cHNlcnQiLCJfY3JlYXRlVXBzZXJ0RG9jdW1lbnQiLCJfcmV0dXJuT2JqZWN0IiwibnVtYmVyQWZmZWN0ZWQiLCJzcGVjaWZpY0lkcyIsIm1hdGNoZWRfYmVmb3JlIiwib2xkX2RvYyIsImFmdGVyTWF0Y2giLCJhZnRlciIsImJlZm9yZSIsIl91cGRhdGVJblJlc3VsdHMiLCJvbGRSZXN1bHRzIiwiX0NhY2hpbmdDaGFuZ2VPYnNlcnZlciIsIm9yZGVyZWRGcm9tQ2FsbGJhY2tzIiwiY2FsbGJhY2tzIiwiZG9jcyIsIk9yZGVyZWREaWN0IiwiaWRTdHJpbmdpZnkiLCJhcHBseUNoYW5nZSIsInB1dEJlZm9yZSIsIm1vdmVCZWZvcmUiLCJEaWZmU2VxdWVuY2UiLCJhcHBseUNoYW5nZXMiLCJJZE1hcCIsImlkUGFyc2UiLCJfX3dyYXBwZWRUcmFuc2Zvcm1fXyIsIndyYXBwZWQiLCJ0cmFuc2Zvcm1lZCIsIm5vbnJlYWN0aXZlIiwiX2JpbmFyeVNlYXJjaCIsImNtcCIsImFycmF5IiwiZmlyc3QiLCJyYW5nZSIsImhhbGZSYW5nZSIsImZsb29yIiwiX2NoZWNrU3VwcG9ydGVkUHJvamVjdGlvbiIsIl9pZFByb2plY3Rpb24iLCJydWxlVHJlZSIsInN1YmRvYyIsInNlbGVjdG9yRG9jdW1lbnQiLCJpc01vZGlmeSIsIl9pc01vZGlmaWNhdGlvbk1vZCIsIm5ld0RvYyIsImlzSW5zZXJ0IiwicmVwbGFjZW1lbnQiLCJfZGlmZk9iamVjdHMiLCJsZWZ0IiwicmlnaHQiLCJkaWZmT2JqZWN0cyIsIm5ld1Jlc3VsdHMiLCJvYnNlcnZlciIsImRpZmZRdWVyeUNoYW5nZXMiLCJfZGlmZlF1ZXJ5T3JkZXJlZENoYW5nZXMiLCJkaWZmUXVlcnlPcmRlcmVkQ2hhbmdlcyIsIl9kaWZmUXVlcnlVbm9yZGVyZWRDaGFuZ2VzIiwiZGlmZlF1ZXJ5VW5vcmRlcmVkQ2hhbmdlcyIsIl9maW5kSW5PcmRlcmVkUmVzdWx0cyIsInN1YklkcyIsIl9pbnNlcnRJblNvcnRlZExpc3QiLCJzcGxpY2UiLCJpc1JlcGxhY2UiLCJpc01vZGlmaWVyIiwic2V0T25JbnNlcnQiLCJtb2RGdW5jIiwiTU9ESUZJRVJTIiwia2V5cGF0aCIsImtleXBhcnRzIiwidGFyZ2V0IiwiZmluZE1vZFRhcmdldCIsImZvcmJpZEFycmF5Iiwibm9DcmVhdGUiLCJOT19DUkVBVEVfTU9ESUZJRVJTIiwicG9wIiwib2JzZXJ2ZUNhbGxiYWNrcyIsInN1cHByZXNzZWQiLCJvYnNlcnZlQ2hhbmdlc0NhbGxiYWNrcyIsIl9vYnNlcnZlQ2FsbGJhY2tzQXJlT3JkZXJlZCIsImluZGljZXMiLCJfbm9faW5kaWNlcyIsImFkZGVkQXQiLCJjaGFuZ2VkQXQiLCJvbGREb2MiLCJtb3ZlZFRvIiwiZnJvbSIsInRvIiwicmVtb3ZlZEF0IiwiY2hhbmdlT2JzZXJ2ZXIiLCJfZnJvbU9ic2VydmUiLCJub25NdXRhdGluZ0NhbGxiYWNrcyIsImNoYW5nZWRGaWVsZHMiLCJtYWtlQ2hhbmdlZEZpZWxkcyIsIm9sZF9pZHgiLCJuZXdfaWR4IiwiJGN1cnJlbnREYXRlIiwiRGF0ZSIsIiRpbmMiLCIkbWluIiwiJG1heCIsIiRtdWwiLCIkcmVuYW1lIiwidGFyZ2V0MiIsIiRzZXRPbkluc2VydCIsIiRwdXNoIiwiJGVhY2giLCJ0b1B1c2giLCJwb3NpdGlvbiIsIiRwb3NpdGlvbiIsIiRzbGljZSIsInNvcnRGdW5jdGlvbiIsIiRzb3J0Iiwic3BsaWNlQXJndW1lbnRzIiwiJHB1c2hBbGwiLCIkYWRkVG9TZXQiLCJpc0VhY2giLCJ2YWx1ZXMiLCJ0b0FkZCIsIiRwb3AiLCJ0b1BvcCIsIiRwdWxsIiwidG9QdWxsIiwib3V0IiwiJHB1bGxBbGwiLCIkYml0IiwiJHYiLCJpbnZhbGlkQ2hhck1zZyIsIiQiLCJhc3NlcnRJc1ZhbGlkRmllbGROYW1lIiwidXNlZEFycmF5SW5kZXgiLCJsYXN0Iiwia2V5cGFydCIsInBhcnNlSW50IiwiRGVjaW1hbCIsIkRlY2ltYWxTdHViIiwiaXNVcGRhdGUiLCJfZG9jTWF0Y2hlciIsIl9jb21waWxlU2VsZWN0b3IiLCJoYXNXaGVyZSIsImtleU9yZGVyU2Vuc2l0aXZlIiwiX3R5cGVvcmRlciIsInQiLCJ0YSIsInRiIiwib2EiLCJvYiIsInRvSGV4U3RyaW5nIiwiaXNOYU4iLCJnZXRUaW1lIiwibWludXMiLCJ0b051bWJlciIsInRvQXJyYXkiLCJMb2NhbENvbGxlY3Rpb25fIiwic3BlYyIsIl9zb3J0U3BlY1BhcnRzIiwiX3NvcnRGdW5jdGlvbiIsImFkZFNwZWNQYXJ0IiwiYXNjZW5kaW5nIiwiY2hhckF0IiwibG9va3VwIiwiX2tleUNvbXBhcmF0b3IiLCJjb21wb3NlQ29tcGFyYXRvcnMiLCJfa2V5RmllbGRDb21wYXJhdG9yIiwiX2dldEJhc2VDb21wYXJhdG9yIiwiX2NvbXBhcmVLZXlzIiwia2V5MSIsImtleTIiLCJfZ2VuZXJhdGVLZXlzRnJvbURvYyIsImNiIiwicGF0aEZyb21JbmRpY2VzIiwia25vd25QYXRocyIsInZhbHVlc0J5SW5kZXhBbmRQYXRoIiwidXNlZFBhdGhzIiwic29sZUtleSIsImRvYzEiLCJkb2MyIiwiX2dldE1pbktleUZyb21Eb2MiLCJtaW5LZXkiLCJpbnZlcnQiLCJjb21wYXJlIiwiY29tcGFyYXRvckFycmF5Il0sIm1hcHBpbmdzIjoiOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FBQUFBLE1BQU0sQ0FBQ0MsSUFBUCxDQUFZLHVCQUFaO0FBQXFDLElBQUlDLE1BQUosRUFBV0MsWUFBWCxFQUF3QkMsZ0JBQXhCLEVBQXlDQyxXQUF6QyxFQUFxREMsaUJBQXJEO0FBQXVFTixNQUFNLENBQUNDLElBQVAsQ0FBWSxhQUFaLEVBQTBCO0FBQUNDLFFBQU0sQ0FBQ0ssQ0FBRCxFQUFHO0FBQUNMLFVBQU0sR0FBQ0ssQ0FBUDtBQUFTLEdBQXBCOztBQUFxQkosY0FBWSxDQUFDSSxD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QUt4QixjQUFMLENBQW9COWpCLENBQXBCLEVBQXVCaWtCLFNBQXZDO0FBRUEsV0FBTyxDQUFDUSxJQUFELEVBQU9DLElBQVAsS0FBZ0I7QUFDckIsWUFBTWEsT0FBTyxHQUFHemtCLGVBQWUsQ0FBQ21GLEVBQWhCLENBQW1CdUksSUFBbkIsQ0FBd0JpVyxJQUFJLENBQUN6a0IsQ0FBRCxDQUE1QixFQUFpQzBrQixJQUFJLENBQUMxa0IsQ0FBRCxDQUFyQyxDQUFoQjs7QUFDQSxhQUFPc2xCLE1BQU0sR0FBRyxDQUFDQyxPQUFKLEdBQWNBLE9BQTNCO0FBQ0QsS0FIRDtBQUlEOztBQW5SeUI7O0FBc1I1QjtBQUNBO0FBQ0E7QUFDQTtBQUNBLFNBQVNsQixrQkFBVCxDQUE0Qm1CLGVBQTVCLEVBQTZDO0FBQzNDLFNBQU8sQ0FBQ2xlLENBQUQsRUFBSUMsQ0FBSixLQUFVO0FBQ2YsU0FBSyxJQUFJdkgsQ0FBQyxHQUFHLENBQWIsRUFBZ0JBLENBQUMsR0FBR3dsQixlQUFlLENBQUN0bEIsTUFBcEMsRUFBNEMsRUFBRUYsQ0FBOUMsRUFBaUQ7QUFDL0MsWUFBTXVsQixPQUFPLEdBQUdDLGVBQWUsQ0FBQ3hsQixDQUFELENBQWYsQ0FBbUJzSCxDQUFuQixFQUFzQkMsQ0FBdEIsQ0FBaEI7O0FBQ0EsVUFBSWdlLE9BQU8sS0FBSyxDQUFoQixFQUFtQjtBQUNqQixlQUFPQSxPQUFQO0FBQ0Q7QUFDRjs7QUFFRCxXQUFPLENBQVA7QUFDRCxHQVREO0FBVUQsQyIsImZpbGUiOiIvcGFja2FnZXMvbWluaW1vbmdvLmpzIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICcuL21pbmltb25nb19jb21tb24uanMnO1xuaW1wb3J0IHtcbiAgaGFzT3duLFxuICBpc051bWVyaWNLZXksXG4gIGlzT3BlcmF0b3JPYmplY3QsXG4gIHBhdGhzVG9UcmVlLFxuICBwcm9qZWN0aW9uRGV0YWlscyxcbn0gZnJvbSAnLi9jb21tb24uanMnO1xuXG5NaW5pbW9uZ28uX3BhdGhzRWxpZGluZ051bWVyaWNLZXlzID0gcGF0aHMgPT4gcGF0aHMubWFwKHBhdGggPT5cbiAgcGF0aC5zcGxpdCgnLicpLmZpbHRlcihwYXJ0ID0+ICFpc051bWVyaWNLZXkocGFydCkpLmpvaW4oJy4nKVxuKTtcblxuLy8gUmV0dXJucyB0cnVlIGlmIHRoZSBtb2RpZmllciBhcHBsaWVkIHRvIHNvbWUgZG9jdW1lbnQgbWF5IGNoYW5nZSB0aGUgcmVzdWx0XG4vLyBvZiBtYXRjaGluZyB0aGUgZG9jdW1lbnQgYnkgc2VsZWN0b3Jcbi8vIFRoZSBtb2RpZmllciBpcyBhbHdheXMgaW4gYSBmb3JtIG9mIE9iamVjdDpcbi8vICAtICRzZXRcbi8vICAgIC0gJ2EuYi4yMi56JzogdmFsdWVcbi8vICAgIC0gJ2Zvby5iYXInOiA0MlxuLy8gIC0gJHVuc2V0XG4vLyAgICAtICdhYmMuZCc6IDFcbk1pbmltb25nby5NYXRjaGVyLnByb3RvdHlwZS5hZmZlY3RlZEJ5TW9kaWZpZXIgPSBmdW5jdGlvbihtb2RpZmllcikge1xuICAvLyBzYWZlIGNoZWNrIGZvciAkc2V0LyR1bnNldCBiZWluZyBvYmplY3RzXG4gIG1vZGlmaWVyID0gT2JqZWN0LmFzc2lnbih7JHNldDoge30sICR1bnNldDoge319LCBtb2RpZmllcik7XG5cbiAgY29uc3QgbWVhbmluZ2Z1bFBhdGhzID0gdGhpcy5fZ2V0UGF0aHMoKTtcbiAgY29uc3QgbW9kaWZpZWRQYXRocyA9IFtdLmNvbmNhdChcbiAgICBPYmplY3Qua2V5cyhtb2RpZmllci4kc2V0KSxcbiAgICBPYmplY3Qua2V5cyhtb2RpZmllci4kdW5zZXQpXG4gICk7XG5cbiAgcmV0dXJuIG1vZGlmaWVkUGF0aHMuc29tZShwYXRoID0+IHtcbiAgICBjb25zdCBtb2QgPSBwYXRoLnNwbGl0KCcuJyk7XG5cbiAgICByZXR1cm4gbWVhbmluZ2Z1bFBhdGhzLnNvbWUobWVhbmluZ2Z1bFBhdGggPT4ge1xuICAgICAgY29uc3Qgc2VsID0gbWVhbmluZ2Z1bFBhdGguc3BsaXQoJy4nKTtcblxuICAgICAgbGV0IGkgPSAwLCBqID0gMDtcblxuICAgICAgd2hpbGUgKGkgPCBzZWwubGVuZ3RoICYmIGogPCBtb2QubGVuZ3RoKSB7XG4gICAgICAgIGlmIChpc051bWVyaWNLZXkoc2VsW2ldKSAmJiBpc051bWVyaWNLZXkobW9kW2pdKSkge1xuICAgICAgICAgIC8vIGZvby40LmJhciBzZWxlY3RvciBhZmZlY3RlZCBieSBmb28uNCBtb2RpZmllclxuICAgICAgICAgIC8vIGZvby4zLmJhciBzZWxlY3RvciB1bmFmZmVjdGVkIGJ5IGZvby40IG1vZGlmaWVyXG4gICAgICAgICAgaWYgKHNlbFtpXSA9PT0gbW9kW2pdKSB7XG4gICAgICAgICAgICBpKys7XG4gICAgICAgICAgICBqKys7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAoaXNOdW1lcmljS2V5KHNlbFtpXSkpIHtcbiAgICAgICAgICAvLyBmb28uNC5iYXIgc2VsZWN0b3IgdW5hZmZlY3RlZCBieSBmb28uYmFyIG1vZGlmaWVyXG4gICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9IGVsc2UgaWYgKGlzTnVtZXJpY0tleShtb2Rbal0pKSB7XG4gICAgICAgICAgaisrO1xuICAgICAgICB9IGVsc2UgaWYgKHNlbFtpXSA9PT0gbW9kW2pdKSB7XG4gICAgICAgICAgaSsrO1xuICAgICAgICAgIGorKztcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgLy8gT25lIGlzIGEgcHJlZml4IG9mIGFub3RoZXIsIHRha2luZyBudW1lcmljIGZpZWxkcyBpbnRvIGFjY291bnRcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0pO1xuICB9KTtcbn07XG5cbi8vIEBwYXJhbSBtb2RpZmllciAtIE9iamVjdDogTW9uZ29EQi1zdHlsZWQgbW9kaWZpZXIgd2l0aCBgJHNldGBzIGFuZCBgJHVuc2V0c2Bcbi8vICAgICAgICAgICAgICAgICAgICAgICAgICAgb25seS4gKGFzc3VtZWQgdG8gY29tZSBmcm9tIG9wbG9nKVxuLy8gQHJldHVybnMgLSBCb29sZWFuOiBpZiBhZnRlciBhcHBseWluZyB0aGUgbW9kaWZpZXIsIHNlbGVjdG9yIGNhbiBzdGFydFxuLy8gICAgICAgICAgICAgICAgICAgICBhY2NlcHRpbmcgdGhlIG1vZGlmaWVkIHZhbHVlLlxuLy8gTk9URTogYXNzdW1lcyB0aGF0IGRvY3VtZW50IGFmZmVjdGVkIGJ5IG1vZGlmaWVyIGRpZG4ndCBtYXRjaCB0aGlzIE1hdGNoZXJcbi8vIGJlZm9yZSwgc28gaWYgbW9kaWZpZXIgY2FuJ3QgY29udmluY2Ugc2VsZWN0b3IgaW4gYSBwb3NpdGl2ZSBjaGFuZ2UgaXQgd291bGRcbi8vIHN0YXkgJ2ZhbHNlJy5cbi8vIEN1cnJlbnRseSBkb2Vzbid0IHN1cHBvcnQgJC1vcGVyYXRvcnMgYW5kIG51bWVyaWMgaW5kaWNlcyBwcmVjaXNlbHkuXG5NaW5pbW9uZ28uTWF0Y2hlci5wcm90b3R5cGUuY2FuQmVjb21lVHJ1ZUJ5TW9kaWZpZXIgPSBmdW5jdGlvbihtb2RpZmllcikge1xuICBpZiAoIXRoaXMuYWZmZWN0ZWRCeU1vZGlmaWVyKG1vZGlmaWVyKSkge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIGlmICghdGhpcy5pc1NpbXBsZSgpKSB7XG4gICAgcmV0dXJuIHRydWU7XG4gIH1cblxuICBtb2RpZmllciA9IE9iamVjdC5hc3NpZ24oeyRzZXQ6IHt9LCAkdW5zZXQ6IHt9fSwgbW9kaWZpZXIpO1xuXG4gIGNvbnN0IG1vZGlmaWVyUGF0aHMgPSBbXS5jb25jYXQoXG4gICAgT2JqZWN0LmtleXMobW9kaWZpZXIuJHNldCksXG4gICAgT2JqZWN0LmtleXMobW9kaWZpZXIuJHVuc2V0KVxuICApO1xuXG4gIGlmICh0aGlzLl9nZXRQYXRocygpLnNvbWUocGF0aEhhc051bWVyaWNLZXlzKSB8fFxuICAgICAgbW9kaWZpZXJQYXRocy5zb21lKHBhdGhIYXNOdW1lcmljS2V5cykpIHtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIC8vIGNoZWNrIGlmIHRoZXJlIGlzIGEgJHNldCBvciAkdW5zZXQgdGhhdCBpbmRpY2F0ZXMgc29tZXRoaW5nIGlzIGFuXG4gIC8vIG9iamVjdCByYXRoZXIgdGhhbiBhIHNjYWxhciBpbiB0aGUgYWN0dWFsIG9iamVjdCB3aGVyZSB3ZSBzYXcgJC1vcGVyYXRvclxuICAvLyBOT1RFOiBpdCBpcyBjb3JyZWN0IHNpbmNlIHdlIGFsbG93IG9ubHkgc2NhbGFycyBpbiAkLW9wZXJhdG9yc1xuICAvLyBFeGFtcGxlOiBmb3Igc2VsZWN0b3IgeydhLmInOiB7JGd0OiA1fX0gdGhlIG1vZGlmaWVyIHsnYS5iLmMnOjd9IHdvdWxkXG4gIC8vIGRlZmluaXRlbHkgc2V0IHRoZSByZXN1bHQgdG8gZmFsc2UgYXMgJ2EuYicgYXBwZWFycyB0byBiZSBhbiBvYmplY3QuXG4gIGNvbnN0IGV4cGVjdGVkU2NhbGFySXNPYmplY3QgPSBPYmplY3Qua2V5cyh0aGlzLl9zZWxlY3Rvcikuc29tZShwYXRoID0+IHtcbiAgICBpZiAoIWlzT3BlcmF0b3JPYmplY3QodGhpcy5fc2VsZWN0b3JbcGF0aF0pKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgcmV0dXJuIG1vZGlmaWVyUGF0aHMuc29tZShtb2RpZmllclBhdGggPT5cbiAgICAgIG1vZGlmaWVyUGF0aC5zdGFydHNXaXRoKGAke3BhdGh9LmApXG4gICAgKTtcbiAgfSk7XG5cbiAgaWYgKGV4cGVjdGVkU2NhbGFySXNPYmplY3QpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cblxuICAvLyBTZWUgaWYgd2UgY2FuIGFwcGx5IHRoZSBtb2RpZmllciBvbiB0aGUgaWRlYWxseSBtYXRjaGluZyBvYmplY3QuIElmIGl0XG4gIC8vIHN0aWxsIG1hdGNoZXMgdGhlIHNlbGVjdG9yLCB0aGVuIHRoZSBtb2RpZmllciBjb3VsZCBoYXZlIHR1cm5lZCB0aGUgcmVhbFxuICAvLyBvYmplY3QgaW4gdGhlIGRhdGFiYXNlIGludG8gc29tZXRoaW5nIG1hdGNoaW5nLlxuICBjb25zdCBtYXRjaGluZ0RvY3VtZW50ID0gRUpTT04uY2xvbmUodGhpcy5tYXRjaGluZ0RvY3VtZW50KCkpO1xuXG4gIC8vIFRoZSBzZWxlY3RvciBpcyB0b28gY29tcGxleCwgYW55dGhpbmcgY2FuIGhhcHBlbi5cbiAgaWYgKG1hdGNoaW5nRG9jdW1lbnQgPT09IG51bGwpIHtcbiAgICByZXR1cm4gdHJ1ZTtcbiAgfVxuXG4gIHRyeSB7XG4gICAgTG9jYWxDb2xsZWN0aW9uLl9tb2RpZnkobWF0Y2hpbmdEb2N1bWVudCwgbW9kaWZpZXIpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIC8vIENvdWxkbid0IHNldCBhIHByb3BlcnR5IG9uIGEgZmllbGQgd2hpY2ggaXMgYSBzY2FsYXIgb3IgbnVsbCBpbiB0aGVcbiAgICAvLyBzZWxlY3Rvci5cbiAgICAvLyBFeGFtcGxlOlxuICAgIC8vIHJlYWwgZG9jdW1lbnQ6IHsgJ2EuYic6IDMgfVxuICAgIC8vIHNlbGVjdG9yOiB7ICdhJzogMTIgfVxuICAgIC8vIGNvbnZlcnRlZCBzZWxlY3RvciAoaWRlYWwgZG9jdW1lbnQpOiB7ICdhJzogMTIgfVxuICAgIC8vIG1vZGlmaWVyOiB7ICRzZXQ6IHsgJ2EuYic6IDQgfSB9XG4gICAgLy8gV2UgZG9uJ3Qga25vdyB3aGF0IHJlYWwgZG9jdW1lbnQgd2FzIGxpa2UgYnV0IGZyb20gdGhlIGVycm9yIHJhaXNlZCBieVxuICAgIC8vICRzZXQgb24gYSBzY2FsYXIgZmllbGQgd2UgY2FuIHJlYXNvbiB0aGF0IHRoZSBzdHJ1Y3R1cmUgb2YgcmVhbCBkb2N1bWVudFxuICAgIC8vIGlzIGNvbXBsZXRlbHkgZGlmZmVyZW50LlxuICAgIGlmIChlcnJvci5uYW1lID09PSAnTWluaW1vbmdvRXJyb3InICYmIGVycm9yLnNldFByb3BlcnR5RXJyb3IpIHtcbiAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxuXG4gIHJldHVybiB0aGlzLmRvY3VtZW50TWF0Y2hlcyhtYXRjaGluZ0RvY3VtZW50KS5yZXN1bHQ7XG59O1xuXG4vLyBLbm93cyBob3cgdG8gY29tYmluZSBhIG1vbmdvIHNlbGVjdG9yIGFuZCBhIGZpZWxkcyBwcm9qZWN0aW9uIHRvIGEgbmV3IGZpZWxkc1xuLy8gcHJvamVjdGlvbiB0YWtpbmcgaW50byBhY2NvdW50IGFjdGl2ZSBmaWVsZHMgZnJvbSB0aGUgcGFzc2VkIHNlbGVjdG9yLlxuLy8gQHJldHVybnMgT2JqZWN0IC0gcHJvamVjdGlvbiBvYmplY3QgKHNhbWUgYXMgZmllbGRzIG9wdGlvbiBvZiBtb25nbyBjdXJzb3IpXG5NaW5pbW9uZ28uTWF0Y2hlci5wcm90b3R5cGUuY29tYmluZUludG9Qcm9qZWN0aW9uID0gZnVuY3Rpb24ocHJvamVjdGlvbikge1xuICBjb25zdCBzZWxlY3RvclBhdGhzID0gTWluaW1vbmdvLl9wYXRoc0VsaWRpbmdOdW1lcmljS2V5cyh0aGlzLl9nZXRQYXRocygpKTtcblxuICAvLyBTcGVjaWFsIGNhc2UgZm9yICR3aGVyZSBvcGVyYXRvciBpbiB0aGUgc2VsZWN0b3IgLSBwcm9qZWN0aW9uIHNob3VsZCBkZXBlbmRcbiAgLy8gb24gYWxsIGZpZWxkcyBvZiB0aGUgZG9jdW1lbnQuIGdldFNlbGVjdG9yUGF0aHMgcmV0dXJucyBhIGxpc3Qgb2YgcGF0aHNcbiAgLy8gc2VsZWN0b3IgZGVwZW5kcyBvbi4gSWYgb25lIG9mIHRoZSBwYXRocyBpcyAnJyAoZW1wdHkgc3RyaW5nKSByZXByZXNlbnRpbmdcbiAgLy8gdGhlIHJvb3Qgb3IgdGhlIHdob2xlIGRvY3VtZW50LCBjb21wbGV0ZSBwcm9qZWN0aW9uIHNob3VsZCBiZSByZXR1cm5lZC5cbiAgaWYgKHNlbGVjdG9yUGF0aHMuaW5jbHVkZXMoJycpKSB7XG4gICAgcmV0dXJuIHt9O1xuICB9XG5cbiAgcmV0dXJuIGNvbWJpbmVJbXBvcnRhbnRQYXRoc0ludG9Qcm9qZWN0aW9uKHNlbGVjdG9yUGF0aHMsIHByb2plY3Rpb24pO1xufTtcblxuLy8gUmV0dXJucyBhbiBvYmplY3QgdGhhdCB3b3VsZCBtYXRjaCB0aGUgc2VsZWN0b3IgaWYgcG9zc2libGUgb3IgbnVsbCBpZiB0aGVcbi8vIHNlbGVjdG9yIGlzIHRvbyBjb21wbGV4IGZvciB1cyB0byBhbmFseXplXG4vLyB7ICdhLmInOiB7IGFuczogNDIgfSwgJ2Zvby5iYXInOiBudWxsLCAnZm9vLmJheic6IFwic29tZXRoaW5nXCIgfVxuLy8gPT4geyBhOiB7IGI6IHsgYW5zOiA0MiB9IH0sIGZvbzogeyBiYXI6IG51bGwsIGJhejogXCJzb21ldGhpbmdcIiB9IH1cbk1pbmltb25nby5NYXRjaGVyLnByb3RvdHlwZS5tYXRjaGluZ0RvY3VtZW50ID0gZnVuY3Rpb24oKSB7XG4gIC8vIGNoZWNrIGlmIGl0IHdhcyBjb21wdXRlZCBiZWZvcmVcbiAgaWYgKHRoaXMuX21hdGNoaW5nRG9jdW1lbnQgIT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiB0aGlzLl9tYXRjaGluZ0RvY3VtZW50O1xuICB9XG5cbiAgLy8gSWYgdGhlIGFuYWx5c2lzIG9mIHRoaXMgc2VsZWN0b3IgaXMgdG9vIGhhcmQgZm9yIG91ciBpbXBsZW1lbnRhdGlvblxuICAvLyBmYWxsYmFjayB0byBcIllFU1wiXG4gIGxldCBmYWxsYmFjayA9IGZhbHNlO1xuXG4gIHRoaXMuX21hdGNoaW5nRG9jdW1lbnQgPSBwYXRoc1RvVHJlZShcbiAgICB0aGlzLl9nZXRQYXRocygpLFxuICAgIHBhdGggPT4ge1xuICAgICAgY29uc3QgdmFsdWVTZWxlY3RvciA9IHRoaXMuX3NlbGVjdG9yW3BhdGhdO1xuXG4gICAgICBpZiAoaXNPcGVyYXRvck9iamVjdCh2YWx1ZVNlbGVjdG9yKSkge1xuICAgICAgICAvLyBpZiB0aGVyZSBpcyBhIHN0cmljdCBlcXVhbGl0eSwgdGhlcmUgaXMgYSBnb29kXG4gICAgICAgIC8vIGNoYW5jZSB3ZSBjYW4gdXNlIG9uZSBvZiB0aG9zZSBhcyBcIm1hdGNoaW5nXCJcbiAgICAgICAgLy8gZHVtbXkgdmFsdWVcbiAgICAgICAgaWYgKHZhbHVlU2VsZWN0b3IuJGVxKSB7XG4gICAgICAgICAgcmV0dXJuIHZhbHVlU2VsZWN0b3IuJGVxO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHZhbHVlU2VsZWN0b3IuJGluKSB7XG4gICAgICAgICAgY29uc3QgbWF0Y2hlciA9IG5ldyBNaW5pbW9uZ28uTWF0Y2hlcih7cGxhY2Vob2xkZXI6IHZhbHVlU2VsZWN0b3J9KTtcblxuICAgICAgICAgIC8vIFJldHVybiBhbnl0aGluZyBmcm9tICRpbiB0aGF0IG1hdGNoZXMgdGhlIHdob2xlIHNlbGVjdG9yIGZvciB0aGlzXG4gICAgICAgICAgLy8gcGF0aC4gSWYgbm90aGluZyBtYXRjaGVzLCByZXR1cm5zIGB1bmRlZmluZWRgIGFzIG5vdGhpbmcgY2FuIG1ha2VcbiAgICAgICAgICAvLyB0aGlzIHNlbGVjdG9yIGludG8gYHRydWVgLlxuICAgICAgICAgIHJldHVybiB2YWx1ZVNlbGVjdG9yLiRpbi5maW5kKHBsYWNlaG9sZGVyID0+XG4gICAgICAgICAgICBtYXRjaGVyLmRvY3VtZW50TWF0Y2hlcyh7cGxhY2Vob2xkZXJ9KS5yZXN1bHRcbiAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG9ubHlDb250YWluc0tleXModmFsdWVTZWxlY3RvciwgWyckZ3QnLCAnJGd0ZScsICckbHQnLCAnJGx0ZSddKSkge1xuICAgICAgICAgIGxldCBsb3dlckJvdW5kID0gLUluZmluaXR5O1xuICAgICAgICAgIGxldCB1cHBlckJvdW5kID0gSW5maW5pdHk7XG5cbiAgICAgICAgICBbJyRsdGUnLCAnJGx0J10uZm9yRWFjaChvcCA9PiB7XG4gICAgICAgICAgICBpZiAoaGFzT3duLmNhbGwodmFsdWVTZWxlY3Rvciwgb3ApICYmXG4gICAgICAgICAgICAgICAgdmFsdWVTZWxlY3RvcltvcF0gPCB1cHBlckJvdW5kKSB7XG4gICAgICAgICAgICAgIHVwcGVyQm91bmQgPSB2YWx1ZVNlbGVjdG9yW29wXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9KTtcblxuICAgICAgICAgIFsnJGd0ZScsICckZ3QnXS5mb3JFYWNoKG9wID0+IHtcbiAgICAgICAgICAgIGlmIChoYXNPd24uY2FsbCh2YWx1ZVNlbGVjdG9yLCBvcCkgJiZcbiAgICAgICAgICAgICAgICB2YWx1ZVNlbGVjdG9yW29wXSA+IGxvd2VyQm91bmQpIHtcbiAgICAgICAgICAgICAgbG93ZXJCb3VuZCA9IHZhbHVlU2VsZWN0b3Jbb3BdO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgY29uc3QgbWlkZGxlID0gKGxvd2VyQm91bmQgKyB1cHBlckJvdW5kKSAvIDI7XG4gICAgICAgICAgY29uc3QgbWF0Y2hlciA9IG5ldyBNaW5pbW9uZ28uTWF0Y2hlcih7cGxhY2Vob2xkZXI6IHZhbHVlU2VsZWN0b3J9KTtcblxuICAgICAgICAgIGlmICghbWF0Y2hlci5kb2N1bWVudE1hdGNoZXMoe3BsYWNlaG9sZGVyOiBtaWRkbGV9KS5yZXN1bHQgJiZcbiAgICAgICAgICAgICAgKG1pZGRsZSA9PT0gbG93ZXJCb3VuZCB8fCBtaWRkbGUgPT09IHVwcGVyQm91bmQpKSB7XG4gICAgICAgICAgICBmYWxsYmFjayA9IHRydWU7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgcmV0dXJuIG1pZGRsZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChvbmx5Q29udGFpbnNLZXlzKHZhbHVlU2VsZWN0b3IsIFsnJG5pbicsICckbmUnXSkpIHtcbiAgICAgICAgICAvLyBTaW5jZSB0aGlzLl9pc1NpbXBsZSBtYWtlcyBzdXJlICRuaW4gYW5kICRuZSBhcmUgbm90IGNvbWJpbmVkIHdpdGhcbiAgICAgICAgICAvLyBvYmplY3RzIG9yIGFycmF5cywgd2UgY2FuIGNvbmZpZGVudGx5IHJldHVybiBhbiBlbXB0eSBvYmplY3QgYXMgaXRcbiAgICAgICAgICAvLyBuZXZlciBtYXRjaGVzIGFueSBzY2FsYXIuXG4gICAgICAgICAgcmV0dXJuIHt9O1xuICAgICAgICB9XG5cbiAgICAgICAgZmFsbGJhY2sgPSB0cnVlO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gdGhpcy5fc2VsZWN0b3JbcGF0aF07XG4gICAgfSxcbiAgICB4ID0+IHgpO1xuXG4gIGlmIChmYWxsYmFjaykge1xuICAgIHRoaXMuX21hdGNoaW5nRG9jdW1lbnQgPSBudWxsO1xuICB9XG5cbiAgcmV0dXJuIHRoaXMuX21hdGNoaW5nRG9jdW1lbnQ7XG59O1xuXG4vLyBNaW5pbW9uZ28uU29ydGVyIGdldHMgYSBzaW1pbGFyIG1ldGhvZCwgd2hpY2ggZGVsZWdhdGVzIHRvIGEgTWF0Y2hlciBpdCBtYWRlXG4vLyBmb3IgdGhpcyBleGFjdCBwdXJwb3NlLlxuTWluaW1vbmdvLlNvcnRlci5wcm90b3R5cGUuYWZmZWN0ZWRCeU1vZGlmaWVyID0gZnVuY3Rpb24obW9kaWZpZXIpIHtcbiAgcmV0dXJuIHRoaXMuX3NlbGVjdG9yRm9yQWZmZWN0ZWRCeU1vZGlmaWVyLmFmZmVjdGVkQnlNb2RpZmllcihtb2RpZmllcik7XG59O1xuXG5NaW5pbW9uZ28uU29ydGVyLnByb3RvdHlwZS5jb21iaW5lSW50b1Byb2plY3Rpb24gPSBmdW5jdGlvbihwcm9qZWN0aW9uKSB7XG4gIHJldHVybiBjb21iaW5lSW1wb3J0YW50UGF0aHNJbnRvUHJvamVjdGlvbihcbiAgICBNaW5pbW9uZ28uX3BhdGhzRWxpZGluZ051bWVyaWNLZXlzKHRoaXMuX2dldFBhdGhzKCkpLFxuICAgIHByb2plY3Rpb25cbiAgKTtcbn07XG5cbmZ1bmN0aW9uIGNvbWJpbmVJbXBvcnRhbnRQYXRoc0ludG9Qcm9qZWN0aW9uKHBhdGhzLCBwcm9qZWN0aW9uKSB7XG4gIGNvbnN0IGRldGFpbHMgPSBwcm9qZWN0aW9uRGV0YWlscyhwcm9qZWN0aW9uKTtcblxuICAvLyBtZXJnZSB0aGUgcGF0aHMgdG8gaW5jbHVkZVxuICBjb25zdCB0cmVlID0gcGF0aHNUb1RyZWUoXG4gICAgcGF0aHMsXG4gICAgcGF0aCA9PiB0cnVlLFxuICAgIChub2RlLCBwYXRoLCBmdWxsUGF0aCkgPT4gdHJ1ZSxcbiAgICBkZXRhaWxzLnRyZWVcbiAgKTtcbiAgY29uc3QgbWVyZ2VkUHJvamVjdGlvbiA9IHRyZWVUb1BhdGhzKHRyZWUpO1xuXG4gIGlmIChkZXRhaWxzLmluY2x1ZGluZykge1xuICAgIC8vIGJvdGggc2VsZWN0b3IgYW5kIHByb2plY3Rpb24gYXJlIHBvaW50aW5nIG9uIGZpZWxkcyB0byBpbmNsdWRlXG4gICAgLy8gc28gd2UgY2FuIGp1c3QgcmV0dXJuIHRoZSBtZXJnZWQgdHJlZVxuICAgIHJldHVybiBtZXJnZWRQcm9qZWN0aW9uO1xuICB9XG5cbiAgLy8gc2VsZWN0b3IgaXMgcG9pbnRpbmcgYXQgZmllbGRzIHRvIGluY2x1ZGVcbiAgLy8gcHJvamVjdGlvbiBpcyBwb2ludGluZyBhdCBmaWVsZHMgdG8gZXhjbHVkZVxuICAvLyBtYWtlIHN1cmUgd2UgZG9uJ3QgZXhjbHVkZSBpbXBvcnRhbnQgcGF0aHNcbiAgY29uc3QgbWVyZ2VkRXhjbFByb2plY3Rpb24gPSB7fTtcblxuICBPYmplY3Qua2V5cyhtZXJnZWRQcm9qZWN0aW9uKS5mb3JFYWNoKHBhdGggPT4ge1xuICAgIGlmICghbWVyZ2VkUHJvamVjdGlvbltwYXRoXSkge1xuICAgICAgbWVyZ2VkRXhjbFByb2plY3Rpb25bcGF0aF0gPSBmYWxzZTtcbiAgICB9XG4gIH0pO1xuXG4gIHJldHVybiBtZXJnZWRFeGNsUHJvamVjdGlvbjtcbn1cblxuZnVuY3Rpb24gZ2V0UGF0aHMoc2VsZWN0b3IpIHtcbiAgcmV0dXJuIE9iamVjdC5rZXlzKG5ldyBNaW5pbW9uZ28uTWF0Y2hlcihzZWxlY3RvcikuX3BhdGhzKTtcblxuICAvLyBYWFggcmVtb3ZlIGl0P1xuICAvLyByZXR1cm4gT2JqZWN0LmtleXMoc2VsZWN0b3IpLm1hcChrID0+IHtcbiAgLy8gICAvLyB3ZSBkb24ndCBrbm93IGhvdyB0byBoYW5kbGUgJHdoZXJlIGJlY2F1c2UgaXQgY2FuIGJlIGFueXRoaW5nXG4gIC8vICAgaWYgKGsgPT09ICckd2hlcmUnKSB7XG4gIC8vICAgICByZXR1cm4gJyc7IC8vIG1hdGNoZXMgZXZlcnl0aGluZ1xuICAvLyAgIH1cblxuICAvLyAgIC8vIHdlIGJyYW5jaCBmcm9tICRvci8kYW5kLyRub3Igb3BlcmF0b3JcbiAgLy8gICBpZiAoWyckb3InLCAnJGFuZCcsICckbm9yJ10uaW5jbHVkZXMoaykpIHtcbiAgLy8gICAgIHJldHVybiBzZWxlY3RvcltrXS5tYXAoZ2V0UGF0aHMpO1xuICAvLyAgIH1cblxuICAvLyAgIC8vIHRoZSB2YWx1ZSBpcyBhIGxpdGVyYWwgb3Igc29tZSBjb21wYXJpc29uIG9wZXJhdG9yXG4gIC8vICAgcmV0dXJuIGs7XG4gIC8vIH0pXG4gIC8vICAgLnJlZHVjZSgoYSwgYikgPT4gYS5jb25jYXQoYiksIFtdKVxuICAvLyAgIC5maWx0ZXIoKGEsIGIsIGMpID0+IGMuaW5kZXhPZihhKSA9PT0gYik7XG59XG5cbi8vIEEgaGVscGVyIHRvIGVuc3VyZSBvYmplY3QgaGFzIG9ubHkgY2VydGFpbiBrZXlzXG5mdW5jdGlvbiBvbmx5Q29udGFpbnNLZXlzKG9iaiwga2V5cykge1xuICByZXR1cm4gT2JqZWN0LmtleXMob2JqKS5ldmVyeShrID0+IGtleXMuaW5jbHVkZXMoaykpO1xufVxuXG5mdW5jdGlvbiBwYXRoSGFzTnVtZXJpY0tleXMocGF0aCkge1xuICByZXR1cm4gcGF0aC5zcGxpdCgnLicpLnNvbWUoaXNOdW1lcmljS2V5KTtcbn1cblxuLy8gUmV0dXJucyBhIHNldCBvZiBrZXkgcGF0aHMgc2ltaWxhciB0b1xuLy8geyAnZm9vLmJhcic6IDEsICdhLmIuYyc6IDEgfVxuZnVuY3Rpb24gdHJlZVRvUGF0aHModHJlZSwgcHJlZml4ID0gJycpIHtcbiAgY29uc3QgcmVzdWx0ID0ge307XG5cbiAgT2JqZWN0LmtleXModHJlZSkuZm9yRWFjaChrZXkgPT4ge1xuICAgIGNvbnN0IHZhbHVlID0gdHJlZVtrZXldO1xuICAgIGlmICh2YWx1ZSA9PT0gT2JqZWN0KHZhbHVlKSkge1xuICAgICAgT2JqZWN0LmFzc2lnbihyZXN1bHQsIHRyZWVUb1BhdGhzKHZhbHVlLCBgJHtwcmVmaXggKyBrZXl9LmApKTtcbiAgICB9IGVsc2Uge1xuICAgICAgcmVzdWx0W3ByZWZpeCArIGtleV0gPSB2YWx1ZTtcbiAgICB9XG4gIH0pO1xuXG4gIHJldHVybiByZXN1bHQ7XG59XG4iLCJpbXBvcnQgTG9jYWxDb2xsZWN0aW9uIGZyb20gJy4vbG9jYWxfY29sbGVjdGlvbi5qcyc7XG5cbmV4cG9ydCBjb25zdCBoYXNPd24gPSBPYmplY3QucHJvdG90eXBlLmhhc093blByb3BlcnR5O1xuXG4vLyBFYWNoIGVsZW1lbnQgc2VsZWN0b3IgY29udGFpbnM6XG4vLyAgLSBjb21waWxlRWxlbWVudFNlbGVjdG9yLCBhIGZ1bmN0aW9uIHdpdGggYXJnczpcbi8vICAgIC0gb3BlcmFuZCAtIHRoZSBcInJpZ2h0IGhhbmQgc2lkZVwiIG9mIHRoZSBvcGVyYXRvclxuLy8gICAgLSB2YWx1ZVNlbGVjdG9yIC0gdGhlIFwiY29udGV4dFwiIGZvciB0aGUgb3BlcmF0b3IgKHNvIHRoYXQgJHJlZ2V4IGNhbiBmaW5kXG4vLyAgICAgICRvcHRpb25zKVxuLy8gICAgLSBtYXRjaGVyIC0gdGhlIE1hdGNoZXIgdGhpcyBpcyBnb2luZyBpbnRvIChzbyB0aGF0ICRlbGVtTWF0Y2ggY2FuIGNvbXBpbGVcbi8vICAgICAgbW9yZSB0aGluZ3MpXG4vLyAgICByZXR1cm5pbmcgYSBmdW5jdGlvbiBtYXBwaW5nIGEgc2luZ2xlIHZhbHVlIHRvIGJvb2wuXG4vLyAgLSBkb250RXhwYW5kTGVhZkFycmF5cywgYSBib29sIHdoaWNoIHByZXZlbnRzIGV4cGFuZEFycmF5c0luQnJhbmNoZXMgZnJvbVxuLy8gICAgYmVpbmcgY2FsbGVkXG4vLyAgLSBkb250SW5jbHVkZUxlYWZBcnJheXMsIGEgYm9vbCB3aGljaCBjYXVzZXMgYW4gYXJndW1lbnQgdG8gYmUgcGFzc2VkIHRvXG4vLyAgICBleHBhbmRBcnJheXNJbkJyYW5jaGVzIGlmIGl0IGlzIGNhbGxlZFxuZXhwb3J0IGNvbnN0IEVMRU1FTlRfT1BFUkFUT1JTID0ge1xuICAkbHQ6IG1ha2VJbmVxdWFsaXR5KGNtcFZhbHVlID0+IGNtcFZhbHVlIDwgMCksXG4gICRndDogbWFrZUluZXF1YWxpdHkoY21wVmFsdWUgPT4gY21wVmFsdWUgPiAwKSxcbiAgJGx0ZTogbWFrZUluZXF1YWxpdHkoY21wVmFsdWUgPT4gY21wVmFsdWUgPD0gMCksXG4gICRndGU6IG1ha2VJbmVxdWFsaXR5KGNtcFZhbHVlID0+IGNtcFZhbHVlID49IDApLFxuICAkbW9kOiB7XG4gICAgY29tcGlsZUVsZW1lbnRTZWxlY3RvcihvcGVyYW5kKSB7XG4gICAgICBpZiAoIShBcnJheS5pc0FycmF5KG9wZXJhbmQpICYmIG9wZXJhbmQubGVuZ3RoID09PSAyXG4gICAgICAgICAgICAmJiB0eXBlb2Ygb3BlcmFuZFswXSA9PT0gJ251bWJlcidcbiAgICAgICAgICAgICYmIHR5cGVvZiBvcGVyYW5kWzFdID09PSAnbnVtYmVyJykpIHtcbiAgICAgICAgdGhyb3cgRXJyb3IoJ2FyZ3VtZW50IHRvICRtb2QgbXVzdCBiZSBhbiBhcnJheSBvZiB0d28gbnVtYmVycycpO1xuICAgICAgfVxuXG4gICAgICAvLyBYWFggY291bGQgcmVxdWlyZSB0byBiZSBpbnRzIG9yIHJvdW5kIG9yIHNvbWV0aGluZ1xuICAgICAgY29uc3QgZGl2aXNvciA9IG9wZXJhbmRbMF07XG4gICAgICBjb25zdCByZW1haW5kZXIgPSBvcGVyYW5kWzFdO1xuICAgICAgcmV0dXJuIHZhbHVlID0+IChcbiAgICAgICAgdHlwZW9mIHZhbHVlID09PSAnbnVtYmVyJyAmJiB2YWx1ZSAlIGRpdmlzb3IgPT09IHJlbWFpbmRlclxuICAgICAgKTtcbiAgICB9LFxuICB9LFxuICAkaW46IHtcbiAgICBjb21waWxlRWxlbWVudFNlbGVjdG9yKG9wZXJhbmQpIHtcbiAgICAgIGlmICghQXJyYXkuaXNBcnJheShvcGVyYW5kKSkge1xuICAgICAgICB0aHJvdyBFcnJvcignJGluIG5lZWRzIGFuIGFycmF5Jyk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IGVsZW1lbnRNYXRjaGVycyA9IG9wZXJhbmQubWFwKG9wdGlvbiA9PiB7XG4gICAgICAgIGlmIChvcHRpb24gaW5zdGFuY2VvZiBSZWdFeHApIHtcbiAgICAgICAgICByZXR1cm4gcmVnZXhwRWxlbWVudE1hdGNoZXIob3B0aW9uKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpc09wZXJhdG9yT2JqZWN0KG9wdGlvbikpIHtcbiAgICAgICAgICB0aHJvdyBFcnJvcignY2Fubm90IG5lc3QgJCB1bmRlciAkaW4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBlcXVhbGl0eUVsZW1lbnRNYXRjaGVyKG9wdGlvbik7XG4gICAgICB9KTtcblxuICAgICAgcmV0dXJuIHZhbHVlID0+IHtcbiAgICAgICAgLy8gQWxsb3cge2E6IHskaW46IFtudWxsXX19IHRvIG1hdGNoIHdoZW4gJ2EnIGRvZXMgbm90IGV4aXN0LlxuICAgICAgICBpZiAodmFsdWUgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIHZhbHVlID0gbnVsbDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBlbGVtZW50TWF0Y2hlcnMuc29tZShtYXRjaGVyID0+IG1hdGNoZXIodmFsdWUpKTtcbiAgICAgIH07XG4gICAgfSxcbiAgfSxcbiAgJHNpemU6IHtcbiAgICAvLyB7YTogW1s1LCA1XV19IG11c3QgbWF0Y2gge2E6IHskc2l6ZTogMX19IGJ1dCBub3Qge2E6IHskc2l6ZTogMn19LCBzbyB3ZVxuICAgIC8vIGRvbid0IHdhbnQgdG8gY29uc2lkZXIgdGhlIGVsZW1lbnQgWzUsNV0gaW4gdGhlIGxlYWYgYXJyYXkgW1s1LDVdXSBhcyBhXG4gICAgLy8gcG9zc2libGUgdmFsdWUuXG4gICAgZG9udEV4cGFuZExlYWZBcnJheXM6IHRydWUsXG4gICAgY29tcGlsZUVsZW1lbnRTZWxlY3RvcihvcGVyYW5kKSB7XG4gICAgICBpZiAodHlwZW9mIG9wZXJhbmQgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgIC8vIERvbid0IGFzayBtZSB3aHksIGJ1dCBieSBleHBlcmltZW50YXRpb24sIHRoaXMgc2VlbXMgdG8gYmUgd2hhdCBNb25nb1xuICAgICAgICAvLyBkb2VzLlxuICAgICAgICBvcGVyYW5kID0gMDtcbiAgICAgIH0gZWxzZSBpZiAodHlwZW9mIG9wZXJhbmQgIT09ICdudW1iZXInKSB7XG4gICAgICAgIHRocm93IEVycm9yKCckc2l6ZSBuZWVkcyBhIG51bWJlcicpO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gdmFsdWUgPT4gQXJyYXkuaXNBcnJheSh2YWx1ZSkgJiYgdmFsdWUubGVuZ3RoID09PSBvcGVyYW5kO1xuICAgIH0sXG4gIH0sXG4gICR0eXBlOiB7XG4gICAgLy8ge2E6IFs1XX0gbXVzdCBub3QgbWF0Y2gge2E6IHskdHlwZTogNH19ICg0IG1lYW5zIGFycmF5KSwgYnV0IGl0IHNob3VsZFxuICAgIC8vIG1hdGNoIHthOiB7JHR5cGU6IDF9fSAoMSBtZWFucyBudW1iZXIpLCBhbmQge2E6IFtbNV1dfSBtdXN0IG1hdGNoIHskYTpcbiAgICAvLyB7JHR5cGU6IDR9fS4gVGh1cywgd2hlbiB3ZSBzZWUgYSBsZWFmIGFycmF5LCB3ZSAqc2hvdWxkKiBleHBhbmQgaXQgYnV0XG4gICAgLy8gc2hvdWxkICpub3QqIGluY2x1ZGUgaXQgaXRzZWxmLlxuICAgIGRvbnRJbmNsdWRlTGVhZkFycmF5czogdHJ1ZSxcbiAgICBjb21waWxlRWxlbWVudFNlbGVjdG9yKG9wZXJhbmQpIHtcbiAgICAgIGlmICh0eXBlb2Ygb3BlcmFuZCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgY29uc3Qgb3BlcmFuZEFsaWFzTWFwID0ge1xuICAgICAgICAgICdkb3VibGUnOiAxLFxuICAgICAgICAgICdzdHJpbmcnOiAyLFxuICAgICAgICAgICdvYmplY3QnOiAzLFxuICAgICAgICAgICdhcnJheSc6IDQsXG4gICAgICAgICAgJ2JpbkRhdGEnOiA1LFxuICAgICAgICAgICd1bmRlZmluZWQnOiA2LFxuICAgICAgICAgICdvYmplY3RJZCc6IDcsXG4gICAgICAgICAgJ2Jvb2wnOiA4LFxuICAgICAgICAgICdkYXRlJzogOSxcbiAgICAgICAgICAnbnVsbCc6IDEwLFxuICAgICAgICAgICdyZWdleCc6IDExLFxuICAgICAgICAgICdkYlBvaW50ZXInOiAxMixcbiAgICAgICAgICAnamF2YXNjcmlwdCc6IDEzLFxuICAgICAgICAgICdzeW1ib2wnOiAxNCxcbiAgICAgICAgICAnamF2YXNjcmlwdFdpdGhTY29wZSc6IDE1LFxuICAgICAgICAgICdpbnQnOiAxNixcbiAgICAgICAgICAndGltZXN0YW1wJzogMTcsXG4gICAgICAgICAgJ2xvbmcnOiAxOCxcbiAgICAgICAgICAnZGVjaW1hbCc6IDE5LFxuICAgICAgICAgICdtaW5LZXknOiAtMSxcbiAgICAgICAgICAnbWF4S2V5JzogMTI3LFxuICAgICAgICB9O1xuICAgICAgICBpZiAoIWhhc093bi5jYWxsKG9wZXJhbmRBbGlhc01hcCwgb3BlcmFuZCkpIHtcbiAgICAgICAgICB0aHJvdyBFcnJvcihgdW5rbm93biBzdHJpbmcgYWxpYXMgZm9yICR0eXBlOiAke29wZXJhbmR9YCk7XG4gICAgICAgIH1cbiAgICAgICAgb3BlcmFuZCA9IG9wZXJhbmRBbGlhc01hcFtvcGVyYW5kXTtcbiAgICAgIH0gZWxzZSBpZiAodHlwZW9mIG9wZXJhbmQgPT09ICdudW1iZXInKSB7XG4gICAgICAgIGlmIChvcGVyYW5kID09PSAwIHx8IG9wZXJhbmQgPCAtMVxuICAgICAgICAgIHx8IChvcGVyYW5kID4gMTkgJiYgb3BlcmFuZCAhPT0gMTI3KSkge1xuICAgICAgICAgIHRocm93IEVycm9yKGBJbnZhbGlkIG51bWVyaWNhbCAkdHlwZSBjb2RlOiAke29wZXJhbmR9YCk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRocm93IEVycm9yKCdhcmd1bWVudCB0byAkdHlwZSBpcyBub3QgYSBudW1iZXIgb3IgYSBzdHJpbmcnKTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHZhbHVlID0+IChcbiAgICAgICAgdmFsdWUgIT09IHVuZGVmaW5lZCAmJiBMb2NhbENvbGxlY3Rpb24uX2YuX3R5cGUodmFsdWUpID09PSBvcGVyYW5kXG4gICAgICApO1xuICAgIH0sXG4gIH0sXG4gICRiaXRzQWxsU2V0OiB7XG4gICAgY29tcGlsZUVsZW1lbnRTZWxlY3RvcihvcGVyYW5kKSB7XG4gICAgICBjb25zdCBtYXNrID0gZ2V0T3BlcmFuZEJpdG1hc2sob3BlcmFuZCwgJyRiaXRzQWxsU2V0Jyk7XG4gICAgICByZXR1cm4gdmFsdWUgPT4ge1xuICAgICAgICBjb25zdCBiaXRtYXNrID0gZ2V0VmFsdWVCaXRtYXNrKHZhbHVlLCBtYXNrLmxlbmd0aCk7XG4gICAgICAgIHJldHVybiBiaXRtYXNrICYmIG1hc2suZXZlcnkoKGJ5dGUsIGkpID0+IChiaXRtYXNrW2ldICYgYnl0ZSkgPT09IGJ5dGUpO1xuICAgICAgfTtcbiAgICB9LFxuICB9LFxuICAkYml0c0FueVNldDoge1xuICAgIGNvbXBpbGVFbGVtZW50U2VsZWN0b3Iob3BlcmFuZCkge1xuICAgICAgY29uc3QgbWFzayA9IGdldE9wZXJhbmRCaXRtYXNrKG9wZXJhbmQsICckYml0c0FueVNldCcpO1xuICAgICAgcmV0dXJuIHZhbHVlID0+IHtcbiAgICAgICAgY29uc3QgYml0bWFzayA9IGdldFZhbHVlQml0bWFzayh2YWx1ZSwgbWFzay5sZW5ndGgpO1xuICAgICAgICByZXR1cm4gYml0bWFzayAmJiBtYXNrLnNvbWUoKGJ5dGUsIGkpID0+ICh+Yml0bWFza1tpXSAmIGJ5dGUpICE9PSBieXRlKTtcbiAgICAgIH07XG4gICAgfSxcbiAgfSxcbiAgJGJpdHNBbGxDbGVhcjoge1xuICAgIGNvbXBpbGVFbGVtZW50U2VsZWN0b3Iob3BlcmFuZCkge1xuICAgICAgY29uc3QgbWFzayA9IGdldE9wZXJhbmRCaXRtYXNrKG9wZXJhbmQsICckYml0c0FsbENsZWFyJyk7XG4gICAgICByZXR1cm4gdmFsdWUgPT4ge1xuICAgICAgICBjb25zdCBiaXRtYXNrID0gZ2V0VmFsdWVCaXRtYXNrKHZhbHVlLCBtYXNrLmxlbmd0aCk7XG4gICAgICAgIHJldHVybiBiaXRtYXNrICYmIG1hc2suZXZlcnkoKGJ5dGUsIGkpID0+ICEoYml0bWFza1tpXSAmIGJ5dGUpKTtcbiAgICAgIH07XG4gICAgfSxcbiAgfSxcbiAgJGJpdHNBbnlDbGVhcjoge1xuICAgIGNvbXBpbGVFbGVtZW50U2VsZWN0b3Iob3BlcmFuZCkge1xuICAgICAgY29uc3QgbWFzayA9IGdldE9wZXJhbmRCaXRtYXNrKG9wZXJhbmQsICckYml0c0FueUNsZWFyJyk7XG4gICAgICByZXR1cm4gdmFsdWUgPT4ge1xuICAgICAgICBjb25zdCBiaXRtYXNrID0gZ2V0VmFsdWVCaXRtYXNrKHZhbHVlLCBtYXNrLmxlbmd0aCk7XG4gICAgICAgIHJldHVybiBiaXRtYXNrICYmIG1hc2suc29tZSgoYnl0ZSwgaSkgPT4gKGJpdG1hc2tbaV0gJiBieXRlKSAhPT0gYnl0ZSk7XG4gICAgICB9O1xuICAgIH0sXG4gIH0sXG4gICRyZWdleDoge1xuICAgIGNvbXBpbGVFbGVtZW50U2VsZWN0b3Iob3BlcmFuZCwgdmFsdWVTZWxlY3Rvcikge1xuICAgICAgaWYgKCEodHlwZW9mIG9wZXJhbmQgPT09ICdzdHJpbmcnIHx8IG9wZXJhbmQgaW5zdGFuY2VvZiBSZWdFeHApKSB7XG4gICAgICAgIHRocm93IEVycm9yKCckcmVnZXggaGFzIHRvIGJlIGEgc3RyaW5nIG9yIFJlZ0V4cCcpO1xuICAgICAgfVxuXG4gICAgICBsZXQgcmVnZXhwO1xuICAgICAgaWYgKHZhbHVlU2VsZWN0b3IuJG9wdGlvbnMgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAvLyBPcHRpb25zIHBhc3NlZCBpbiAkb3B0aW9ucyAoZXZlbiB0aGUgZW1wdHkgc3RyaW5nKSBhbHdheXMgb3ZlcnJpZGVzXG4gICAgICAgIC8vIG9wdGlvbnMgaW4gdGhlIFJlZ0V4cCBvYmplY3QgaXRzZWxmLlxuXG4gICAgICAgIC8vIEJlIGNsZWFyIHRoYXQgd2Ugb25seSBzdXBwb3J0IHRoZSBKUy1zdXBwb3J0ZWQgb3B0aW9ucywgbm90IGV4dGVuZGVkXG4gICAgICAgIC8vIG9uZXMgKGVnLCBNb25nbyBzdXBwb3J0cyB4IGFuZCBzKS4gSWRlYWxseSB3ZSB3b3VsZCBpbXBsZW1lbnQgeCBhbmQgc1xuICAgICAgICAvLyBieSB0cmFuc2Zvcm1pbmcgdGhlIHJlZ2V4cCwgYnV0IG5vdCB0b2RheS4uLlxuICAgICAgICBpZiAoL1teZ2ltXS8udGVzdCh2YWx1ZVNlbGVjdG9yLiRvcHRpb25zKSkge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT25seSB0aGUgaSwgbSwgYW5kIGcgcmVnZXhwIG9wdGlvbnMgYXJlIHN1cHBvcnRlZCcpO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3Qgc291cmNlID0gb3BlcmFuZCBpbnN0YW5jZW9mIFJlZ0V4cCA/IG9wZXJhbmQuc291cmNlIDogb3BlcmFuZDtcbiAgICAgICAgcmVnZXhwID0gbmV3IFJlZ0V4cChzb3VyY2UsIHZhbHVlU2VsZWN0b3IuJG9wdGlvbnMpO1xuICAgICAgfSBlbHNlIGlmIChvcGVyYW5kIGluc3RhbmNlb2YgUmVnRXhwKSB7XG4gICAgICAgIHJlZ2V4cCA9IG9wZXJhbmQ7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZWdleHAgPSBuZXcgUmVnRXhwKG9wZXJhbmQpO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gcmVnZXhwRWxlbWVudE1hdGNoZXIocmVnZXhwKTtcbiAgICB9LFxuICB9LFxuICAkZWxlbU1hdGNoOiB7XG4gICAgZG9udEV4cGFuZExlYWZBcnJheXM6IHRydWUsXG4gICAgY29tcGlsZUVsZW1lbnRTZWxlY3RvcihvcGVyYW5kLCB2YWx1ZVNlbGVjdG9yLCBtYXRjaGVyKSB7XG4gICAgICBpZiAoIUxvY2FsQ29sbGVjdGlvbi5faXNQbGFpbk9iamVjdChvcGVyYW5kKSkge1xuICAgICAgICB0aHJvdyBFcnJvcignJGVsZW1NYXRjaCBuZWVkIGFuIG9iamVjdCcpO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBpc0RvY01hdGNoZXIgPSAhaXNPcGVyYXRvck9iamVjdChcbiAgICAgICAgT2JqZWN0LmtleXMob3BlcmFuZClcbiAgICAgICAgICAuZmlsdGVyKGtleSA9PiAhaGFzT3duLmNhbGwoTE9HSUNBTF9PUEVSQVRPUlMsIGtleSkpXG4gICAgICAgICAgLnJlZHVjZSgoYSwgYikgPT4gT2JqZWN0LmFzc2lnbihhLCB7W2JdOiBvcGVyYW5kW2JdfSksIHt9KSxcbiAgICAgICAgdHJ1ZSk7XG5cbiAgICAgIGxldCBzdWJNYXRjaGVyO1xuICAgICAgaWYgKGlzRG9jTWF0Y2hlcikge1xuICAgICAgICAvLyBUaGlzIGlzIE5PVCB0aGUgc2FtZSBhcyBjb21waWxlVmFsdWVTZWxlY3RvcihvcGVyYW5kKSwgYW5kIG5vdCBqdXN0XG4gICAgICAgIC8vIGJlY2F1c2Ugb2YgdGhlIHNsaWdodGx5IGRpZmZlcmVudCBjYWxsaW5nIGNvbnZlbnRpb24uXG4gICAgICAgIC8vIHskZWxlbU1hdGNoOiB7eDogM319IG1lYW5zIFwiYW4gZWxlbWVudCBoYXMgYSBmaWVsZCB4OjNcIiwgbm90XG4gICAgICAgIC8vIFwiY29uc2lzdHMgb25seSBvZiBhIGZpZWxkIHg6M1wiLiBBbHNvLCByZWdleHBzIGFuZCBzdWItJCBhcmUgYWxsb3dlZC5cbiAgICAgICAgc3ViTWF0Y2hlciA9XG4gICAgICAgICAgY29tcGlsZURvY3VtZW50U2VsZWN0b3Iob3BlcmFuZCwgbWF0Y2hlciwge2luRWxlbU1hdGNoOiB0cnVlfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzdWJNYXRjaGVyID0gY29tcGlsZVZhbHVlU2VsZWN0b3Iob3BlcmFuZCwgbWF0Y2hlcik7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiB2YWx1ZSA9PiB7XG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgIH1cblxuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IHZhbHVlLmxlbmd0aDsgKytpKSB7XG4gICAgICAgICAgY29uc3QgYXJyYXlFbGVtZW50ID0gdmFsdWVbaV07XG4gICAgICAgICAgbGV0IGFyZztcbiAgICAgICAgICBpZiAoaXNEb2NNYXRjaGVyKSB7XG4gICAgICAgICAgICAvLyBXZSBjYW4gb25seSBtYXRjaCB7JGVsZW1NYXRjaDoge2I6IDN9fSBhZ2FpbnN0IG9iamVjdHMuXG4gICAgICAgICAgICAvLyAoV2UgY2FuIGFsc28gbWF0Y2ggYWdhaW5zdCBhcnJheXMsIGlmIHRoZXJlJ3MgbnVtZXJpYyBpbmRpY2VzLFxuICAgICAgICAgICAgLy8gZWcgeyRlbGVtTWF0Y2g6IHsnMC5iJzogM319IG9yIHskZWxlbU1hdGNoOiB7MDogM319LilcbiAgICAgICAgICAgIGlmICghaXNJbmRleGFibGUoYXJyYXlFbGVtZW50KSkge1xuICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGFyZyA9IGFycmF5RWxlbWVudDtcbiAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy8gZG9udEl0ZXJhdGUgZW5zdXJlcyB0aGF0IHthOiB7JGVsZW1NYXRjaDogeyRndDogNX19fSBtYXRjaGVzXG4gICAgICAgICAgICAvLyB7YTogWzhdfSBidXQgbm90IHthOiBbWzhdXX1cbiAgICAgICAgICAgIGFyZyA9IFt7dmFsdWU6IGFycmF5RWxlbWVudCwgZG9udEl0ZXJhdGU6IHRydWV9XTtcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8gWFhYIHN1cHBvcnQgJG5lYXIgaW4gJGVsZW1NYXRjaCBieSBwcm9wYWdhdGluZyAkZGlzdGFuY2U/XG4gICAgICAgICAgaWYgKHN1Yk1hdGNoZXIoYXJnKS5yZXN1bHQpIHtcbiAgICAgICAgICAgIHJldHVybiBpOyAvLyBzcGVjaWFsbHkgdW5kZXJzdG9vZCB0byBtZWFuIFwidXNlIGFzIGFycmF5SW5kaWNlc1wiXG4gICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgfTtcbiAgICB9LFxuICB9LFxufTtcblxuLy8gT3BlcmF0b3JzIHRoYXQgYXBwZWFyIGF0IHRoZSB0b3AgbGV2ZWwgb2YgYSBkb2N1bWVudCBzZWxlY3Rvci5cbmNvbnN0IExPR0lDQUxfT1BFUkFUT1JTID0ge1xuICAkYW5kKHN1YlNlbGVjdG9yLCBtYXRjaGVyLCBpbkVsZW1NYXRjaCkge1xuICAgIHJldHVybiBhbmREb2N1bWVudE1hdGNoZXJzKFxuICAgICAgY29tcGlsZUFycmF5T2ZEb2N1bWVudFNlbGVjdG9ycyhzdWJTZWxlY3RvciwgbWF0Y2hlciwgaW5FbGVtTWF0Y2gpXG4gICAgKTtcbiAgfSxcblxuICAkb3Ioc3ViU2VsZWN0b3IsIG1hdGNoZXIsIGluRWxlbU1hdGNoKSB7XG4gICAgY29uc3QgbWF0Y2hlcnMgPSBjb21waWxlQXJyYXlPZkRvY3VtZW50U2VsZWN0b3JzKFxuICAgICAgc3ViU2VsZWN0b3IsXG4gICAgICBtYXRjaGVyLFxuICAgICAgaW5FbGVtTWF0Y2hcbiAgICApO1xuXG4gICAgLy8gU3BlY2lhbCBjYXNlOiBpZiB0aGVyZSBpcyBvbmx5IG9uZSBtYXRjaGVyLCB1c2UgaXQgZGlyZWN0bHksICpwcmVzZXJ2aW5nKlxuICAgIC8vIGFueSBhcnJheUluZGljZXMgaXQgcmV0dXJucy5cbiAgICBpZiAobWF0Y2hlcnMubGVuZ3RoID09PSAxKSB7XG4gICAgICByZXR1cm4gbWF0Y2hlcnNbMF07XG4gICAgfVxuXG4gICAgcmV0dXJuIGRvYyA9PiB7XG4gICAgICBjb25zdCByZXN1bHQgPSBtYXRjaGVycy5zb21lKGZuID0+IGZuKGRvYykucmVzdWx0KTtcbiAgICAgIC8vICRvciBkb2VzIE5PVCBzZXQgYXJyYXlJbmRpY2VzIHdoZW4gaXQgaGFzIG11bHRpcGxlXG4gICAgICAvLyBzdWItZXhwcmVzc2lvbnMuIChUZXN0ZWQgYWdhaW5zdCBNb25nb0RCLilcbiAgICAgIHJldHVybiB7cmVzdWx0fTtcbiAgICB9O1xuICB9LFxuXG4gICRub3Ioc3ViU2VsZWN0b3IsIG1hdGNoZXIsIGluRWxlbU1hdGNoKSB7XG4gICAgY29uc3QgbWF0Y2hlcnMgPSBjb21waWxlQXJyYXlPZkRvY3VtZW50U2VsZWN0b3JzKFxuICAgICAgc3ViU2VsZWN0b3IsXG4gICAgICBtYXRjaGVyLFxuICAgICAgaW5FbGVtTWF0Y2hcbiAgICApO1xuICAgIHJldHVybiBkb2MgPT4ge1xuICAgICAgY29uc3QgcmVzdWx0ID0gbWF0Y2hlcnMuZXZlcnkoZm4gPT4gIWZuKGRvYykucmVzdWx0KTtcbiAgICAgIC8vIE5ldmVyIHNldCBhcnJheUluZGljZXMsIGJlY2F1c2Ugd2Ugb25seSBtYXRjaCBpZiBub3RoaW5nIGluIHBhcnRpY3VsYXJcbiAgICAgIC8vICdtYXRjaGVkJyAoYW5kIGJlY2F1c2UgdGhpcyBpcyBjb25zaXN0ZW50IHdpdGggTW9uZ29EQikuXG4gICAgICByZXR1cm4ge3Jlc3VsdH07XG4gICAgfTtcbiAgfSxcblxuICAkd2hlcmUoc2VsZWN0b3JWYWx1ZSwgbWF0Y2hlcikge1xuICAgIC8vIFJlY29yZCB0aGF0ICphbnkqIHBhdGggbWF5IGJlIHVzZWQuXG4gICAgbWF0Y2hlci5fcmVjb3JkUGF0aFVzZWQoJycpO1xuICAgIG1hdGNoZXIuX2hhc1doZXJlID0gdHJ1ZTtcblxuICAgIGlmICghKHNlbGVjdG9yVmFsdWUgaW5zdGFuY2VvZiBGdW5jdGlvbikpIHtcbiAgICAgIC8vIFhYWCBNb25nb0RCIHNlZW1zIHRvIGhhdmUgbW9yZSBjb21wbGV4IGxvZ2ljIHRvIGRlY2lkZSB3aGVyZSBvciBvciBub3RcbiAgICAgIC8vIHRvIGFkZCAncmV0dXJuJzsgbm90IHN1cmUgZXhhY3RseSB3aGF0IGl0IGlzLlxuICAgICAgc2VsZWN0b3JWYWx1ZSA9IEZ1bmN0aW9uKCdvYmonLCBgcmV0dXJuICR7c2VsZWN0b3JWYWx1ZX1gKTtcbiAgICB9XG5cbiAgICAvLyBXZSBtYWtlIHRoZSBkb2N1bWVudCBhdmFpbGFibGUgYXMgYm90aCBgdGhpc2AgYW5kIGBvYmpgLlxuICAgIC8vIC8vIFhYWCBub3Qgc3VyZSB3aGF0IHdlIHNob3VsZCBkbyBpZiB0aGlzIHRocm93c1xuICAgIHJldHVybiBkb2MgPT4gKHtyZXN1bHQ6IHNlbGVjdG9yVmFsdWUuY2FsbChkb2MsIGRvYyl9KTtcbiAgfSxcblxuICAvLyBUaGlzIGlzIGp1c3QgdXNlZCBhcyBhIGNvbW1lbnQgaW4gdGhlIHF1ZXJ5IChpbiBNb25nb0RCLCBpdCBhbHNvIGVuZHMgdXAgaW5cbiAgLy8gcXVlcnkgbG9ncyk7IGl0IGhhcyBubyBlZmZlY3Qgb24gdGhlIGFjdHVhbCBzZWxlY3Rpb24uXG4gICRjb21tZW50KCkge1xuICAgIHJldHVybiAoKSA9PiAoe3Jlc3VsdDogdHJ1ZX0pO1xuICB9LFxufTtcblxuLy8gT3BlcmF0b3JzIHRoYXQgKHVubGlrZSBMT0dJQ0FMX09QRVJBVE9SUykgcGVydGFpbiB0byBpbmRpdmlkdWFsIHBhdGhzIGluIGFcbi8vIGRvY3VtZW50LCBidXQgKHVubGlrZSBFTEVNRU5UX09QRVJBVE9SUykgZG8gbm90IGhhdmUgYSBzaW1wbGUgZGVmaW5pdGlvbiBhc1xuLy8gXCJtYXRjaCBlYWNoIGJyYW5jaGVkIHZhbHVlIGluZGVwZW5kZW50bHkgYW5kIGNvbWJpbmUgd2l0aFxuLy8gY29udmVydEVsZW1lbnRNYXRjaGVyVG9CcmFuY2hlZE1hdGNoZXJcIi5cbmNvbnN0IFZBTFVFX09QRVJBVE9SUyA9IHtcbiAgJGVxKG9wZXJhbmQpIHtcbiAgICByZXR1cm4gY29udmVydEVsZW1lbnRNYXRjaGVyVG9CcmFuY2hlZE1hdGNoZXIoXG4gICAgICBlcXVhbGl0eUVsZW1lbnRNYXRjaGVyKG9wZXJhbmQpXG4gICAgKTtcbiAgfSxcbiAgJG5vdChvcGVyYW5kLCB2YWx1ZVNlbGVjdG9yLCBtYXRjaGVyKSB7XG4gICAgcmV0dXJuIGludmVydEJyYW5jaGVkTWF0Y2hlcihjb21waWxlVmFsdWVTZWxlY3RvcihvcGVyYW5kLCBtYXRjaGVyKSk7XG4gIH0sXG4gICRuZShvcGVyYW5kKSB7XG4gICAgcmV0dXJuIGludmVydEJyYW5jaGVkTWF0Y2hlcihcbiAgICAgIGNvbnZlcnRFbGVtZW50TWF0Y2hlclRvQnJhbmNoZWRNYXRjaGVyKGVxdWFsaXR5RWxlbWVudE1hdGNoZXIob3BlcmFuZCkpXG4gICAgKTtcbiAgfSxcbiAgJG5pbihvcGVyYW5kKSB7XG4gICAgcmV0dXJuIGludmVydEJyYW5jaGVkTWF0Y2hlcihcbiAgICAgIGNvbnZlcnRFbGVtZW50TWF0Y2hlclRvQnJhbmNoZWRNYXRjaGVyKFxuICAgICAgICBFTEVNRU5UX09QRVJBVE9SUy4kaW4uY29tcGlsZUVsZW1lbnRTZWxlY3RvcihvcGVyYW5kKVxuICAgICAgKVxuICAgICk7XG4gIH0sXG4gICRleGlzdHMob3BlcmFuZCkge1xuICAgIGNvbnN0IGV4aXN0cyA9IGNvbnZlcnRFbGVtZW50TWF0Y2hlclRvQnJhbmNoZWRNYXRjaGVyKFxuICAgICAgdmFsdWUgPT4gdmFsdWUgIT09IHVuZGVmaW5lZFxuICAgICk7XG4gICAgcmV0dXJuIG9wZXJhbmQgPyBleGlzdHMgOiBpbnZlcnRCcmFuY2hlZE1hdGNoZXIoZXhpc3RzKTtcbiAgfSxcbiAgLy8gJG9wdGlvbnMganVzdCBwcm92aWRlcyBvcHRpb25zIGZvciAkcmVnZXg7IGl0cyBsb2dpYyBpcyBpbnNpZGUgJHJlZ2V4XG4gICRvcHRpb25zKG9wZXJhbmQsIHZhbHVlU2VsZWN0b3IpIHtcbiAgICBpZiAoIWhhc093bi5jYWxsKHZhbHVlU2VsZWN0b3IsICckcmVnZXgnKSkge1xuICAgICAgdGhyb3cgRXJyb3IoJyRvcHRpb25zIG5lZWRzIGEgJHJlZ2V4Jyk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGV2ZXJ5dGhpbmdNYXRjaGVyO1xuICB9LFxuICAvLyAkbWF4RGlzdGFuY2UgaXMgYmFzaWNhbGx5IGFuIGFyZ3VtZW50IHRvICRuZWFyXG4gICRtYXhEaXN0YW5jZShvcGVyYW5kLCB2YWx1ZVNlbGVjdG9yKSB7XG4gICAgaWYgKCF2YWx1ZVNlbGVjdG9yLiRuZWFyKSB7XG4gICAgICB0aHJvdyBFcnJvcignJG1heERpc3RhbmNlIG5lZWRzIGEgJG5lYXInKTtcbiAgICB9XG5cbiAgICByZXR1cm4gZXZlcnl0aGluZ01hdGNoZXI7XG4gIH0sXG4gICRhbGwob3BlcmFuZCwgdmFsdWVTZWxlY3RvciwgbWF0Y2hlcikge1xuICAgIGlmICghQXJyYXkuaXNBcnJheShvcGVyYW5kKSkge1xuICAgICAgdGhyb3cgRXJyb3IoJyRhbGwgcmVxdWlyZXMgYXJyYXknKTtcbiAgICB9XG5cbiAgICAvLyBOb3Qgc3VyZSB3aHksIGJ1dCB0aGlzIHNlZW1zIHRvIGJlIHdoYXQgTW9uZ29EQiBkb2VzLlxuICAgIGlmIChvcGVyYW5kLmxlbmd0aCA9PT0gMCkge1xuICAgICAgcmV0dXJuIG5vdGhpbmdNYXRjaGVyO1xuICAgIH1cblxuICAgIGNvbnN0IGJyYW5jaGVkTWF0Y2hlcnMgPSBvcGVyYW5kLm1hcChjcml0ZXJpb24gPT4ge1xuICAgICAgLy8gWFhYIGhhbmRsZSAkYWxsLyRlbGVtTWF0Y2ggY29tYmluYXRpb25cbiAgICAgIGlmIChpc09wZXJhdG9yT2JqZWN0KGNyaXRlcmlvbikpIHtcbiAgICAgICAgdGhyb3cgRXJyb3IoJ25vICQgZXhwcmVzc2lvbnMgaW4gJGFsbCcpO1xuICAgICAgfVxuXG4gICAgICAvLyBUaGlzIGlzIGFsd2F5cyBhIHJlZ2V4cCBvciBlcXVhbGl0eSBzZWxlY3Rvci5cbiAgICAgIHJldHVybiBjb21waWxlVmFsdWVTZWxlY3Rvcihjcml0ZXJpb24sIG1hdGNoZXIpO1xuICAgIH0pO1xuXG4gICAgLy8gYW5kQnJhbmNoZWRNYXRjaGVycyBkb2VzIE5PVCByZXF1aXJlIGFsbCBzZWxlY3RvcnMgdG8gcmV0dXJuIHRydWUgb24gdGhlXG4gICAgLy8gU0FNRSBicmFuY2guXG4gICAgcmV0dXJuIGFuZEJyYW5jaGVkTWF0Y2hlcnMoYnJhbmNoZWRNYXRjaGVycyk7XG4gIH0sXG4gICRuZWFyKG9wZXJhbmQsIHZhbHVlU2VsZWN0b3IsIG1hdGNoZXIsIGlzUm9vdCkge1xuICAgIGlmICghaXNSb290KSB7XG4gICAgICB0aHJvdyBFcnJvcignJG5lYXIgY2FuXFwndCBiZSBpbnNpZGUgYW5vdGhlciAkIG9wZXJhdG9yJyk7XG4gICAgfVxuXG4gICAgbWF0Y2hlci5faGFzR2VvUXVlcnkgPSB0cnVlO1xuXG4gICAgLy8gVGhlcmUgYXJlIHR3byBraW5kcyBvZiBnZW9kYXRhIGluIE1vbmdvREI6IGxlZ2FjeSBjb29yZGluYXRlIHBhaXJzIGFuZFxuICAgIC8vIEdlb0pTT04uIFRoZXkgdXNlIGRpZmZlcmVudCBkaXN0YW5jZSBtZXRyaWNzLCB0b28uIEdlb0pTT04gcXVlcmllcyBhcmVcbiAgICAvLyBtYXJrZWQgd2l0aCBhICRnZW9tZXRyeSBwcm9wZXJ0eSwgdGhvdWdoIGxlZ2FjeSBjb29yZGluYXRlcyBjYW4gYmVcbiAgICAvLyBtYXRjaGVkIHVzaW5nICRnZW9tZXRyeS5cbiAgICBsZXQgbWF4RGlzdGFuY2UsIHBvaW50LCBkaXN0YW5jZTtcbiAgICBpZiAoTG9jYWxDb2xsZWN0aW9uLl9pc1BsYWluT2JqZWN0KG9wZXJhbmQpICYmIGhhc093bi5jYWxsKG9wZXJhbmQsICckZ2VvbWV0cnknKSkge1xuICAgICAgLy8gR2VvSlNPTiBcIjJkc3BoZXJlXCIgbW9kZS5cbiAgICAgIG1heERpc3RhbmNlID0gb3BlcmFuZC4kbWF4RGlzdGFuY2U7XG4gICAgICBwb2ludCA9IG9wZXJhbmQuJGdlb21ldHJ5O1xuICAgICAgZGlzdGFuY2UgPSB2YWx1ZSA9PiB7XG4gICAgICAgIC8vIFhYWDogZm9yIG5vdywgd2UgZG9uJ3QgY2FsY3VsYXRlIHRoZSBhY3R1YWwgZGlzdGFuY2UgYmV0d2Vlbiwgc2F5LFxuICAgICAgICAvLyBwb2x5Z29uIGFuZCBjaXJjbGUuIElmIHBlb3BsZSBjYXJlIGFib3V0IHRoaXMgdXNlLWNhc2UgaXQgd2lsbCBnZXRcbiAgICAgICAgLy8gYSBwcmlvcml0eS5cbiAgICAgICAgaWYgKCF2YWx1ZSkge1xuICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCF2YWx1ZS50eXBlKSB7XG4gICAgICAgICAgcmV0dXJuIEdlb0pTT04ucG9pbnREaXN0YW5jZShcbiAgICAgICAgICAgIHBvaW50LFxuICAgICAgICAgICAge3R5cGU6ICdQb2ludCcsIGNvb3JkaW5hdGVzOiBwb2ludFRvQXJyYXkodmFsdWUpfVxuICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodmFsdWUudHlwZSA9PT0gJ1BvaW50Jykge1xuICAgICAgICAgIHJldHVybiBHZW9KU09OLnBvaW50RGlzdGFuY2UocG9pbnQsIHZhbHVlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBHZW9KU09OLmdlb21ldHJ5V2l0aGluUmFkaXVzKHZhbHVlLCBwb2ludCwgbWF4RGlzdGFuY2UpXG4gICAgICAgICAgPyAwXG4gICAgICAgICAgOiBtYXhEaXN0YW5jZSArIDE7XG4gICAgICB9O1xuICAgIH0gZWxzZSB7XG4gICAgICBtYXhEaXN0YW5jZSA9IHZhbHVlU2VsZWN0b3IuJG1heERpc3RhbmNlO1xuXG4gICAgICBpZiAoIWlzSW5kZXhhYmxlKG9wZXJhbmQpKSB7XG4gICAgICAgIHRocm93IEVycm9yKCckbmVhciBhcmd1bWVudCBtdXN0IGJlIGNvb3JkaW5hdGUgcGFpciBvciBHZW9KU09OJyk7XG4gICAgICB9XG5cbiAgICAgIHBvaW50ID0gcG9pbnRUb0FycmF5KG9wZXJhbmQpO1xuXG4gICAgICBkaXN0YW5jZSA9IHZhbHVlID0+IHtcbiAgICAgICAgaWYgKCFpc0luZGV4YWJsZSh2YWx1ZSkpIHtcbiAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBkaXN0YW5jZUNvb3JkaW5hdGVQYWlycyhwb2ludCwgdmFsdWUpO1xuICAgICAgfTtcbiAgICB9XG5cbiAgICByZXR1cm4gYnJhbmNoZWRWYWx1ZXMgPT4ge1xuICAgICAgLy8gVGhlcmUgbWlnaHQgYmUgbXVsdGlwbGUgcG9pbnRzIGluIHRoZSBkb2N1bWVudCB0aGF0IG1hdGNoIHRoZSBnaXZlblxuICAgICAgLy8gZmllbGQuIE9ubHkgb25lIG9mIHRoZW0gbmVlZHMgdG8gYmUgd2l0aGluICRtYXhEaXN0YW5jZSwgYnV0IHdlIG5lZWQgdG9cbiAgICAgIC8vIGV2YWx1YXRlIGFsbCBvZiB0aGVtIGFuZCB1c2UgdGhlIG5lYXJlc3Qgb25lIGZvciB0aGUgaW1wbGljaXQgc29ydFxuICAgICAgLy8gc3BlY2lmaWVyLiAoVGhhdCdzIHdoeSB3ZSBjYW4ndCBqdXN0IHVzZSBFTEVNRU5UX09QRVJBVE9SUyBoZXJlLilcbiAgICAgIC8vXG4gICAgICAvLyBOb3RlOiBUaGlzIGRpZmZlcnMgZnJvbSBNb25nb0RCJ3MgaW1wbGVtZW50YXRpb24sIHdoZXJlIGEgZG9jdW1lbnQgd2lsbFxuICAgICAgLy8gYWN0dWFsbHkgc2hvdyB1cCAqbXVsdGlwbGUgdGltZXMqIGluIHRoZSByZXN1bHQgc2V0LCB3aXRoIG9uZSBlbnRyeSBmb3JcbiAgICAgIC8vIGVhY2ggd2l0aGluLSRtYXhEaXN0YW5jZSBicmFuY2hpbmcgcG9pbnQuXG4gICAgICBjb25zdCByZXN1bHQgPSB7cmVzdWx0OiBmYWxzZX07XG4gICAgICBleHBhbmRBcnJheXNJbkJyYW5jaGVzKGJyYW5jaGVkVmFsdWVzKS5ldmVyeShicmFuY2ggPT4ge1xuICAgICAgICAvLyBpZiBvcGVyYXRpb24gaXMgYW4gdXBkYXRlLCBkb24ndCBza2lwIGJyYW5jaGVzLCBqdXN0IHJldHVybiB0aGUgZmlyc3RcbiAgICAgICAgLy8gb25lICgjMzU5OSlcbiAgICAgICAgbGV0IGN1ckRpc3RhbmNlO1xuICAgICAgICBpZiAoIW1hdGNoZXIuX2lzVXBkYXRlKSB7XG4gICAgICAgICAgaWYgKCEodHlwZW9mIGJyYW5jaC52YWx1ZSA9PT0gJ29iamVjdCcpKSB7XG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBjdXJEaXN0YW5jZSA9IGRpc3RhbmNlKGJyYW5jaC52YWx1ZSk7XG5cbiAgICAgICAgICAvLyBTa2lwIGJyYW5jaGVzIHRoYXQgYXJlbid0IHJlYWwgcG9pbnRzIG9yIGFyZSB0b28gZmFyIGF3YXkuXG4gICAgICAgICAgaWYgKGN1ckRpc3RhbmNlID09PSBudWxsIHx8IGN1ckRpc3RhbmNlID4gbWF4RGlzdGFuY2UpIHtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIC8vIFNraXAgYW55dGhpbmcgdGhhdCdzIGEgdGllLlxuICAgICAgICAgIGlmIChyZXN1bHQuZGlzdGFuY2UgIT09IHVuZGVmaW5lZCAmJiByZXN1bHQuZGlzdGFuY2UgPD0gY3VyRGlzdGFuY2UpIHtcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJlc3VsdC5yZXN1bHQgPSB0cnVlO1xuICAgICAgICByZXN1bHQuZGlzdGFuY2UgPSBjdXJEaXN0YW5jZTtcblxuICAgICAgICBpZiAoYnJhbmNoLmFycmF5SW5kaWNlcykge1xuICAgICAgICAgIHJlc3VsdC5hcnJheUluZGljZXMgPSBicmFuY2guYXJyYXlJbmRpY2VzO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIGRlbGV0ZSByZXN1bHQuYXJyYXlJbmRpY2VzO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuICFtYXRjaGVyLl9pc1VwZGF0ZTtcbiAgICAgIH0pO1xuXG4gICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH07XG4gIH0sXG59O1xuXG4vLyBOQjogV2UgYXJlIGNoZWF0aW5nIGFuZCB1c2luZyB0aGlzIGZ1bmN0aW9uIHRvIGltcGxlbWVudCAnQU5EJyBmb3IgYm90aFxuLy8gJ2RvY3VtZW50IG1hdGNoZXJzJyBhbmQgJ2JyYW5jaGVkIG1hdGNoZXJzJy4gVGhleSBib3RoIHJldHVybiByZXN1bHQgb2JqZWN0c1xuLy8gYnV0IHRoZSBhcmd1bWVudCBpcyBkaWZmZXJlbnQ6IGZvciB0aGUgZm9ybWVyIGl0J3MgYSB3aG9sZSBkb2MsIHdoZXJlYXMgZm9yXG4vLyB0aGUgbGF0dGVyIGl0J3MgYW4gYXJyYXkgb2YgJ2JyYW5jaGVkIHZhbHVlcycuXG5mdW5jdGlvbiBhbmRTb21lTWF0Y2hlcnMoc3ViTWF0Y2hlcnMpIHtcbiAgaWYgKHN1Yk1hdGNoZXJzLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiBldmVyeXRoaW5nTWF0Y2hlcjtcbiAgfVxuXG4gIGlmIChzdWJNYXRjaGVycy5sZW5ndGggPT09IDEpIHtcbiAgICByZXR1cm4gc3ViTWF0Y2hlcnNbMF07XG4gIH1cblxuICByZXR1cm4gZG9jT3JCcmFuY2hlcyA9PiB7XG4gICAgY29uc3QgbWF0Y2ggPSB7fTtcbiAgICBtYXRjaC5yZXN1bHQgPSBzdWJNYXRjaGVycy5ldmVyeShmbiA9PiB7XG4gICAgICBjb25zdCBzdWJSZXN1bHQgPSBmbihkb2NPckJyYW5jaGVzKTtcblxuICAgICAgLy8gQ29weSBhICdkaXN0YW5jZScgbnVtYmVyIG91dCBvZiB0aGUgZmlyc3Qgc3ViLW1hdGNoZXIgdGhhdCBoYXNcbiAgICAgIC8vIG9uZS4gWWVzLCB0aGlzIG1lYW5zIHRoYXQgaWYgdGhlcmUgYXJlIG11bHRpcGxlICRuZWFyIGZpZWxkcyBpbiBhXG4gICAgICAvLyBxdWVyeSwgc29tZXRoaW5nIGFyYml0cmFyeSBoYXBwZW5zOyB0aGlzIGFwcGVhcnMgdG8gYmUgY29uc2lzdGVudCB3aXRoXG4gICAgICAvLyBNb25nby5cbiAgICAgIGlmIChzdWJSZXN1bHQucmVzdWx0ICYmXG4gICAgICAgICAgc3ViUmVzdWx0LmRpc3RhbmNlICE9PSB1bmRlZmluZWQgJiZcbiAgICAgICAgICBtYXRjaC5kaXN0YW5jZSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIG1hdGNoLmRpc3RhbmNlID0gc3ViUmVzdWx0LmRpc3RhbmNlO1xuICAgICAgfVxuXG4gICAgICAvLyBTaW1pbGFybHksIHByb3BhZ2F0ZSBhcnJheUluZGljZXMgZnJvbSBzdWItbWF0Y2hlcnMuLi4gYnV0IHRvIG1hdGNoXG4gICAgICAvLyBNb25nb0RCIGJlaGF2aW9yLCB0aGlzIHRpbWUgdGhlICpsYXN0KiBzdWItbWF0Y2hlciB3aXRoIGFycmF5SW5kaWNlc1xuICAgICAgLy8gd2lucy5cbiAgICAgIGlmIChzdWJSZXN1bHQucmVzdWx0ICYmIHN1YlJlc3VsdC5hcnJheUluZGljZXMpIHtcbiAgICAgICAgbWF0Y2guYXJyYXlJbmRpY2VzID0gc3ViUmVzdWx0LmFycmF5SW5kaWNlcztcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHN1YlJlc3VsdC5yZXN1bHQ7XG4gICAgfSk7XG5cbiAgICAvLyBJZiB3ZSBkaWRuJ3QgYWN0dWFsbHkgbWF0Y2gsIGZvcmdldCBhbnkgZXh0cmEgbWV0YWRhdGEgd2UgY2FtZSB1cCB3aXRoLlxuICAgIGlmICghbWF0Y2gucmVzdWx0KSB7XG4gICAgICBkZWxldGUgbWF0Y2guZGlzdGFuY2U7XG4gICAgICBkZWxldGUgbWF0Y2guYXJyYXlJbmRpY2VzO1xuICAgIH1cblxuICAgIHJldHVybiBtYXRjaDtcbiAgfTtcbn1cblxuY29uc3QgYW5kRG9jdW1lbnRNYXRjaGVycyA9IGFuZFNvbWVNYXRjaGVycztcbmNvbnN0IGFuZEJyYW5jaGVkTWF0Y2hlcnMgPSBhbmRTb21lTWF0Y2hlcnM7XG5cbmZ1bmN0aW9uIGNvbXBpbGVBcnJheU9mRG9jdW1lbnRTZWxlY3RvcnMoc2VsZWN0b3JzLCBtYXRjaGVyLCBpbkVsZW1NYXRjaCkge1xuICBpZiAoIUFycmF5LmlzQXJyYXkoc2VsZWN0b3JzKSB8fCBzZWxlY3RvcnMubGVuZ3RoID09PSAwKSB7XG4gICAgdGhyb3cgRXJyb3IoJyRhbmQvJG9yLyRub3IgbXVzdCBiZSBub25lbXB0eSBhcnJheScpO1xuICB9XG5cbiAgcmV0dXJuIHNlbGVjdG9ycy5tYXAoc3ViU2VsZWN0b3IgPT4ge1xuICAgIGlmICghTG9jYWxDb2xsZWN0aW9uLl9pc1BsYWluT2JqZWN0KHN1YlNlbGVjdG9yKSkge1xuICAgICAgdGhyb3cgRXJyb3IoJyRvci8kYW5kLyRub3IgZW50cmllcyBuZWVkIHRvIGJlIGZ1bGwgb2JqZWN0cycpO1xuICAgIH1cblxuICAgIHJldHVybiBjb21waWxlRG9jdW1lbnRTZWxlY3RvcihzdWJTZWxlY3RvciwgbWF0Y2hlciwge2luRWxlbU1hdGNofSk7XG4gIH0pO1xufVxuXG4vLyBUYWtlcyBpbiBhIHNlbGVjdG9yIHRoYXQgY291bGQgbWF0Y2ggYSBmdWxsIGRvY3VtZW50IChlZywgdGhlIG9yaWdpbmFsXG4vLyBzZWxlY3RvcikuIFJldHVybnMgYSBmdW5jdGlvbiBtYXBwaW5nIGRvY3VtZW50LT5yZXN1bHQgb2JqZWN0LlxuLy9cbi8vIG1hdGNoZXIgaXMgdGhlIE1hdGNoZXIgb2JqZWN0IHdlIGFyZSBjb21waWxpbmcuXG4vL1xuLy8gSWYgdGhpcyBpcyB0aGUgcm9vdCBkb2N1bWVudCBzZWxlY3RvciAoaWUsIG5vdCB3cmFwcGVkIGluICRhbmQgb3IgdGhlIGxpa2UpLFxuLy8gdGhlbiBpc1Jvb3QgaXMgdHJ1ZS4gKFRoaXMgaXMgdXNlZCBieSAkbmVhci4pXG5leHBvcnQgZnVuY3Rpb24gY29tcGlsZURvY3VtZW50U2VsZWN0b3IoZG9jU2VsZWN0b3IsIG1hdGNoZXIsIG9wdGlvbnMgPSB7fSkge1xuICBjb25zdCBkb2NNYXRjaGVycyA9IE9iamVjdC5rZXlzKGRvY1NlbGVjdG9yKS5tYXAoa2V5ID0+IHtcbiAgICBjb25zdCBzdWJTZWxlY3RvciA9IGRvY1NlbGVjdG9yW2tleV07XG5cbiAgICBpZiAoa2V5LnN1YnN0cigwLCAxKSA9PT0gJyQnKSB7XG4gICAgICAvLyBPdXRlciBvcGVyYXRvcnMgYXJlIGVpdGhlciBsb2dpY2FsIG9wZXJhdG9ycyAodGhleSByZWN1cnNlIGJhY2sgaW50b1xuICAgICAgLy8gdGhpcyBmdW5jdGlvbiksIG9yICR3aGVyZS5cbiAgICAgIGlmICghaGFzT3duLmNhbGwoTE9HSUNBTF9PUEVSQVRPUlMsIGtleSkpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbnJlY29nbml6ZWQgbG9naWNhbCBvcGVyYXRvcjogJHtrZXl9YCk7XG4gICAgICB9XG5cbiAgICAgIG1hdGNoZXIuX2lzU2ltcGxlID0gZmFsc2U7XG4gICAgICByZXR1cm4gTE9HSUNBTF9PUEVSQVRPUlNba2V5XShzdWJTZWxlY3RvciwgbWF0Y2hlciwgb3B0aW9ucy5pbkVsZW1NYXRjaCk7XG4gICAgfVxuXG4gICAgLy8gUmVjb3JkIHRoaXMgcGF0aCwgYnV0IG9ubHkgaWYgd2UgYXJlbid0IGluIGFuIGVsZW1NYXRjaGVyLCBzaW5jZSBpbiBhblxuICAgIC8vIGVsZW1NYXRjaCB0aGlzIGlzIGEgcGF0aCBpbnNpZGUgYW4gb2JqZWN0IGluIGFuIGFycmF5LCBub3QgaW4gdGhlIGRvY1xuICAgIC8vIHJvb3QuXG4gICAgaWYgKCFvcHRpb25zLmluRWxlbU1hdGNoKSB7XG4gICAgICBtYXRjaGVyLl9yZWNvcmRQYXRoVXNlZChrZXkpO1xuICAgIH1cblxuICAgIC8vIERvbid0IGFkZCBhIG1hdGNoZXIgaWYgc3ViU2VsZWN0b3IgaXMgYSBmdW5jdGlvbiAtLSB0aGlzIGlzIHRvIG1hdGNoXG4gICAgLy8gdGhlIGJlaGF2aW9yIG9mIE1ldGVvciBvbiB0aGUgc2VydmVyIChpbmhlcml0ZWQgZnJvbSB0aGUgbm9kZSBtb25nb2RiXG4gICAgLy8gZHJpdmVyKSwgd2hpY2ggaXMgdG8gaWdub3JlIGFueSBwYXJ0IG9mIGEgc2VsZWN0b3Igd2hpY2ggaXMgYSBmdW5jdGlvbi5cbiAgICBpZiAodHlwZW9mIHN1YlNlbGVjdG9yID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIGNvbnN0IGxvb2tVcEJ5SW5kZXggPSBtYWtlTG9va3VwRnVuY3Rpb24oa2V5KTtcbiAgICBjb25zdCB2YWx1ZU1hdGNoZXIgPSBjb21waWxlVmFsdWVTZWxlY3RvcihcbiAgICAgIHN1YlNlbGVjdG9yLFxuICAgICAgbWF0Y2hlcixcbiAgICAgIG9wdGlvbnMuaXNSb290XG4gICAgKTtcblxuICAgIHJldHVybiBkb2MgPT4gdmFsdWVNYXRjaGVyKGxvb2tVcEJ5SW5kZXgoZG9jKSk7XG4gIH0pLmZpbHRlcihCb29sZWFuKTtcblxuICByZXR1cm4gYW5kRG9jdW1lbnRNYXRjaGVycyhkb2NNYXRjaGVycyk7XG59XG5cbi8vIFRha2VzIGluIGEgc2VsZWN0b3IgdGhhdCBjb3VsZCBtYXRjaCBhIGtleS1pbmRleGVkIHZhbHVlIGluIGEgZG9jdW1lbnQ7IGVnLFxuLy8geyRndDogNSwgJGx0OiA5fSwgb3IgYSByZWd1bGFyIGV4cHJlc3Npb24sIG9yIGFueSBub24tZXhwcmVzc2lvbiBvYmplY3QgKHRvXG4vLyBpbmRpY2F0ZSBlcXVhbGl0eSkuICBSZXR1cm5zIGEgYnJhbmNoZWQgbWF0Y2hlcjogYSBmdW5jdGlvbiBtYXBwaW5nXG4vLyBbYnJhbmNoZWQgdmFsdWVdLT5yZXN1bHQgb2JqZWN0LlxuZnVuY3Rpb24gY29tcGlsZVZhbHVlU2VsZWN0b3IodmFsdWVTZWxlY3RvciwgbWF0Y2hlciwgaXNSb290KSB7XG4gIGlmICh2YWx1ZVNlbGVjdG9yIGluc3RhbmNlb2YgUmVnRXhwKSB7XG4gICAgbWF0Y2hlci5faXNTaW1wbGUgPSBmYWxzZTtcbiAgICByZXR1cm4gY29udmVydEVsZW1lbnRNYXRjaGVyVG9CcmFuY2hlZE1hdGNoZXIoXG4gICAgICByZWdleHBFbGVtZW50TWF0Y2hlcih2YWx1ZVNlbGVjdG9yKVxuICAgICk7XG4gIH1cblxuICBpZiAoaXNPcGVyYXRvck9iamVjdCh2YWx1ZVNlbGVjdG9yKSkge1xuICAgIHJldHVybiBvcGVyYXRvckJyYW5jaGVkTWF0Y2hlcih2YWx1ZVNlbGVjdG9yLCBtYXRjaGVyLCBpc1Jvb3QpO1xuICB9XG5cbiAgcmV0dXJuIGNvbnZlcnRFbGVtZW50TWF0Y2hlclRvQnJhbmNoZWRNYXRjaGVyKFxuICAgIGVxdWFsaXR5RWxlbWVudE1hdGNoZXIodmFsdWVTZWxlY3RvcilcbiAgKTtcbn1cblxuLy8gR2l2ZW4gYW4gZWxlbWVudCBtYXRjaGVyICh3aGljaCBldmFsdWF0ZXMgYSBzaW5nbGUgdmFsdWUpLCByZXR1cm5zIGEgYnJhbmNoZWRcbi8vIHZhbHVlICh3aGljaCBldmFsdWF0ZXMgdGhlIGVsZW1lbnQgbWF0Y2hlciBvbiBhbGwgdGhlIGJyYW5jaGVzIGFuZCByZXR1cm5zIGFcbi8vIG1vcmUgc3RydWN0dXJlZCByZXR1cm4gdmFsdWUgcG9zc2libHkgaW5jbHVkaW5nIGFycmF5SW5kaWNlcykuXG5mdW5jdGlvbiBjb252ZXJ0RWxlbWVudE1hdGNoZXJUb0JyYW5jaGVkTWF0Y2hlcihlbGVtZW50TWF0Y2hlciwgb3B0aW9ucyA9IHt9KSB7XG4gIHJldHVybiBicmFuY2hlcyA9PiB7XG4gICAgY29uc3QgZXhwYW5kZWQgPSBvcHRpb25zLmRvbnRFeHBhbmRMZWFmQXJyYXlzXG4gICAgICA/IGJyYW5jaGVzXG4gICAgICA6IGV4cGFuZEFycmF5c0luQnJhbmNoZXMoYnJhbmNoZXMsIG9wdGlvbnMuZG9udEluY2x1ZGVMZWFmQXJyYXlzKTtcblxuICAgIGNvbnN0IG1hdGNoID0ge307XG4gICAgbWF0Y2gucmVzdWx0ID0gZXhwYW5kZWQuc29tZShlbGVtZW50ID0+IHtcbiAgICAgIGxldCBtYXRjaGVkID0gZWxlbWVudE1hdGNoZXIoZWxlbWVudC52YWx1ZSk7XG5cbiAgICAgIC8vIFNwZWNpYWwgY2FzZSBmb3IgJGVsZW1NYXRjaDogaXQgbWVhbnMgXCJ0cnVlLCBhbmQgdXNlIHRoaXMgYXMgYW4gYXJyYXlcbiAgICAgIC8vIGluZGV4IGlmIEkgZGlkbid0IGFscmVhZHkgaGF2ZSBvbmVcIi5cbiAgICAgIGlmICh0eXBlb2YgbWF0Y2hlZCA9PT0gJ251bWJlcicpIHtcbiAgICAgICAgLy8gWFhYIFRoaXMgY29kZSBkYXRlcyBmcm9tIHdoZW4gd2Ugb25seSBzdG9yZWQgYSBzaW5nbGUgYXJyYXkgaW5kZXhcbiAgICAgICAgLy8gKGZvciB0aGUgb3V0ZXJtb3N0IGFycmF5KS4gU2hvdWxkIHdlIGJlIGFsc28gaW5jbHVkaW5nIGRlZXBlciBhcnJheVxuICAgICAgICAvLyBpbmRpY2VzIGZyb20gdGhlICRlbGVtTWF0Y2ggbWF0Y2g/XG4gICAgICAgIGlmICghZWxlbWVudC5hcnJheUluZGljZXMpIHtcbiAgICAgICAgICBlbGVtZW50LmFycmF5SW5kaWNlcyA9IFttYXRjaGVkXTtcbiAgICAgICAgfVxuXG4gICAgICAgIG1hdGNoZWQgPSB0cnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBJZiBzb21lIGVsZW1lbnQgbWF0Y2hlZCwgYW5kIGl0J3MgdGFnZ2VkIHdpdGggYXJyYXkgaW5kaWNlcywgaW5jbHVkZVxuICAgICAgLy8gdGhvc2UgaW5kaWNlcyBpbiBvdXIgcmVzdWx0IG9iamVjdC5cbiAgICAgIGlmIChtYXRjaGVkICYmIGVsZW1lbnQuYXJyYXlJbmRpY2VzKSB7XG4gICAgICAgIG1hdGNoLmFycmF5SW5kaWNlcyA9IGVsZW1lbnQuYXJyYXlJbmRpY2VzO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gbWF0Y2hlZDtcbiAgICB9KTtcblxuICAgIHJldHVybiBtYXRjaDtcbiAgfTtcbn1cblxuLy8gSGVscGVycyBmb3IgJG5lYXIuXG5mdW5jdGlvbiBkaXN0YW5jZUNvb3JkaW5hdGVQYWlycyhhLCBiKSB7XG4gIGNvbnN0IHBvaW50QSA9IHBvaW50VG9BcnJheShhKTtcbiAgY29uc3QgcG9pbnRCID0gcG9pbnRUb0FycmF5KGIpO1xuXG4gIHJldHVybiBNYXRoLmh5cG90KHBvaW50QVswXSAtIHBvaW50QlswXSwgcG9pbnRBWzFdIC0gcG9pbnRCWzFdKTtcbn1cblxuLy8gVGFrZXMgc29tZXRoaW5nIHRoYXQgaXMgbm90IGFuIG9wZXJhdG9yIG9iamVjdCBhbmQgcmV0dXJucyBhbiBlbGVtZW50IG1hdGNoZXJcbi8vIGZvciBlcXVhbGl0eSB3aXRoIHRoYXQgdGhpbmcuXG5leHBvcnQgZnVuY3Rpb24gZXF1YWxpdHlFbGVtZW50TWF0Y2hlcihlbGVtZW50U2VsZWN0b3IpIHtcbiAgaWYgKGlzT3BlcmF0b3JPYmplY3QoZWxlbWVudFNlbGVjdG9yKSkge1xuICAgIHRocm93IEVycm9yKCdDYW5cXCd0IGNyZWF0ZSBlcXVhbGl0eVZhbHVlU2VsZWN0b3IgZm9yIG9wZXJhdG9yIG9iamVjdCcpO1xuICB9XG5cbiAgLy8gU3BlY2lhbC1jYXNlOiBudWxsIGFuZCB1bmRlZmluZWQgYXJlIGVxdWFsIChpZiB5b3UgZ290IHVuZGVmaW5lZCBpbiB0aGVyZVxuICAvLyBzb21ld2hlcmUsIG9yIGlmIHlvdSBnb3QgaXQgZHVlIHRvIHNvbWUgYnJhbmNoIGJlaW5nIG5vbi1leGlzdGVudCBpbiB0aGVcbiAgLy8gd2VpcmQgc3BlY2lhbCBjYXNlKSwgZXZlbiB0aG91Z2ggdGhleSBhcmVuJ3Qgd2l0aCBFSlNPTi5lcXVhbHMuXG4gIC8vIHVuZGVmaW5lZCBvciBudWxsXG4gIGlmIChlbGVtZW50U2VsZWN0b3IgPT0gbnVsbCkge1xuICAgIHJldHVybiB2YWx1ZSA9PiB2YWx1ZSA9PSBudWxsO1xuICB9XG5cbiAgcmV0dXJuIHZhbHVlID0+IExvY2FsQ29sbGVjdGlvbi5fZi5fZXF1YWwoZWxlbWVudFNlbGVjdG9yLCB2YWx1ZSk7XG59XG5cbmZ1bmN0aW9uIGV2ZXJ5dGhpbmdNYXRjaGVyKGRvY09yQnJhbmNoZWRWYWx1ZXMpIHtcbiAgcmV0dXJuIHtyZXN1bHQ6IHRydWV9O1xufVxuXG5leHBvcnQgZnVuY3Rpb24gZXhwYW5kQXJyYXlzSW5CcmFuY2hlcyhicmFuY2hlcywgc2tpcFRoZUFycmF5cykge1xuICBjb25zdCBicmFuY2hlc091dCA9IFtdO1xuXG4gIGJyYW5jaGVzLmZvckVhY2goYnJhbmNoID0+IHtcbiAgICBjb25zdCB0aGlzSXNBcnJheSA9IEFycmF5LmlzQXJyYXkoYnJhbmNoLnZhbHVlKTtcblxuICAgIC8vIFdlIGluY2x1ZGUgdGhlIGJyYW5jaCBpdHNlbGYsICpVTkxFU1MqIHdlIGl0J3MgYW4gYXJyYXkgdGhhdCB3ZSdyZSBnb2luZ1xuICAgIC8vIHRvIGl0ZXJhdGUgYW5kIHdlJ3JlIHRvbGQgdG8gc2tpcCBhcnJheXMuICAoVGhhdCdzIHJpZ2h0LCB3ZSBpbmNsdWRlIHNvbWVcbiAgICAvLyBhcnJheXMgZXZlbiBza2lwVGhlQXJyYXlzIGlzIHRydWU6IHRoZXNlIGFyZSBhcnJheXMgdGhhdCB3ZXJlIGZvdW5kIHZpYVxuICAgIC8vIGV4cGxpY2l0IG51bWVyaWNhbCBpbmRpY2VzLilcbiAgICBpZiAoIShza2lwVGhlQXJyYXlzICYmIHRoaXNJc0FycmF5ICYmICFicmFuY2guZG9udEl0ZXJhdGUpKSB7XG4gICAgICBicmFuY2hlc091dC5wdXNoKHthcnJheUluZGljZXM6IGJyYW5jaC5hcnJheUluZGljZXMsIHZhbHVlOiBicmFuY2gudmFsdWV9KTtcbiAgICB9XG5cbiAgICBpZiAodGhpc0lzQXJyYXkgJiYgIWJyYW5jaC5kb250SXRlcmF0ZSkge1xuICAgICAgYnJhbmNoLnZhbHVlLmZvckVhY2goKHZhbHVlLCBpKSA9PiB7XG4gICAgICAgIGJyYW5jaGVzT3V0LnB1c2goe1xuICAgICAgICAgIGFycmF5SW5kaWNlczogKGJyYW5jaC5hcnJheUluZGljZXMgfHwgW10pLmNvbmNhdChpKSxcbiAgICAgICAgICB2YWx1ZVxuICAgICAgICB9KTtcbiAgICAgIH0pO1xuICAgIH1cbiAgfSk7XG5cbiAgcmV0dXJuIGJyYW5jaGVzT3V0O1xufVxuXG4vLyBIZWxwZXJzIGZvciAkYml0c0FsbFNldC8kYml0c0FueVNldC8kYml0c0FsbENsZWFyLyRiaXRzQW55Q2xlYXIuXG5mdW5jdGlvbiBnZXRPcGVyYW5kQml0bWFzayhvcGVyYW5kLCBzZWxlY3Rvcikge1xuICAvLyBudW1lcmljIGJpdG1hc2tcbiAgLy8gWW91IGNhbiBwcm92aWRlIGEgbnVtZXJpYyBiaXRtYXNrIHRvIGJlIG1hdGNoZWQgYWdhaW5zdCB0aGUgb3BlcmFuZCBmaWVsZC5cbiAgLy8gSXQgbXVzdCBiZSByZXByZXNlbnRhYmxlIGFzIGEgbm9uLW5lZ2F0aXZlIDMyLWJpdCBzaWduZWQgaW50ZWdlci5cbiAgLy8gT3RoZXJ3aXNlLCAkYml0c0FsbFNldCB3aWxsIHJldHVybiBhbiBlcnJvci5cbiAgaWYgKE51bWJlci5pc0ludGVnZXIob3BlcmFuZCkgJiYgb3BlcmFuZCA+PSAwKSB7XG4gICAgcmV0dXJuIG5ldyBVaW50OEFycmF5KG5ldyBJbnQzMkFycmF5KFtvcGVyYW5kXSkuYnVmZmVyKTtcbiAgfVxuXG4gIC8vIGJpbmRhdGEgYml0bWFza1xuICAvLyBZb3UgY2FuIGFsc28gdXNlIGFuIGFyYml0cmFyaWx5IGxhcmdlIEJpbkRhdGEgaW5zdGFuY2UgYXMgYSBiaXRtYXNrLlxuICBpZiAoRUpTT04uaXNCaW5hcnkob3BlcmFuZCkpIHtcbiAgICByZXR1cm4gbmV3IFVpbnQ4QXJyYXkob3BlcmFuZC5idWZmZXIpO1xuICB9XG5cbiAgLy8gcG9zaXRpb24gbGlzdFxuICAvLyBJZiBxdWVyeWluZyBhIGxpc3Qgb2YgYml0IHBvc2l0aW9ucywgZWFjaCA8cG9zaXRpb24+IG11c3QgYmUgYSBub24tbmVnYXRpdmVcbiAgLy8gaW50ZWdlci4gQml0IHBvc2l0aW9ucyBzdGFydCBhdCAwIGZyb20gdGhlIGxlYXN0IHNpZ25pZmljYW50IGJpdC5cbiAgaWYgKEFycmF5LmlzQXJyYXkob3BlcmFuZCkgJiZcbiAgICAgIG9wZXJhbmQuZXZlcnkoeCA9PiBOdW1iZXIuaXNJbnRlZ2VyKHgpICYmIHggPj0gMCkpIHtcbiAgICBjb25zdCBidWZmZXIgPSBuZXcgQXJyYXlCdWZmZXIoKE1hdGgubWF4KC4uLm9wZXJhbmQpID4+IDMpICsgMSk7XG4gICAgY29uc3QgdmlldyA9IG5ldyBVaW50OEFycmF5KGJ1ZmZlcik7XG5cbiAgICBvcGVyYW5kLmZvckVhY2goeCA9PiB7XG4gICAgICB2aWV3W3ggPj4gM10gfD0gMSA8PCAoeCAmIDB4Nyk7XG4gICAgfSk7XG5cbiAgICByZXR1cm4gdmlldztcbiAgfVxuXG4gIC8vIGJhZCBvcGVyYW5kXG4gIHRocm93IEVycm9yKFxuICAgIGBvcGVyYW5kIHRvICR7c2VsZWN0b3J9IG11c3QgYmUgYSBudW1lcmljIGJpdG1hc2sgKHJlcHJlc2VudGFibGUgYXMgYSBgICtcbiAgICAnbm9uLW5lZ2F0aXZlIDMyLWJpdCBzaWduZWQgaW50ZWdlciksIGEgYmluZGF0YSBiaXRtYXNrIG9yIGFuIGFycmF5IHdpdGggJyArXG4gICAgJ2JpdCBwb3NpdGlvbnMgKG5vbi1uZWdhdGl2ZSBpbnRlZ2VycyknXG4gICk7XG59XG5cbmZ1bmN0aW9uIGdldFZhbHVlQml0bWFzayh2YWx1ZSwgbGVuZ3RoKSB7XG4gIC8vIFRoZSBmaWVsZCB2YWx1ZSBtdXN0IGJlIGVpdGhlciBudW1lcmljYWwgb3IgYSBCaW5EYXRhIGluc3RhbmNlLiBPdGhlcndpc2UsXG4gIC8vICRiaXRzLi4uIHdpbGwgbm90IG1hdGNoIHRoZSBjdXJyZW50IGRvY3VtZW50LlxuXG4gIC8vIG51bWVyaWNhbFxuICBpZiAoTnVtYmVyLmlzU2FmZUludGVnZXIodmFsdWUpKSB7XG4gICAgLy8gJGJpdHMuLi4gd2lsbCBub3QgbWF0Y2ggbnVtZXJpY2FsIHZhbHVlcyB0aGF0IGNhbm5vdCBiZSByZXByZXNlbnRlZCBhcyBhXG4gICAgLy8gc2lnbmVkIDY0LWJpdCBpbnRlZ2VyLiBUaGlzIGNhbiBiZSB0aGUgY2FzZSBpZiBhIHZhbHVlIGlzIGVpdGhlciB0b29cbiAgICAvLyBsYXJnZSBvciBzbWFsbCB0byBmaXQgaW4gYSBzaWduZWQgNjQtYml0IGludGVnZXIsIG9yIGlmIGl0IGhhcyBhXG4gICAgLy8gZnJhY3Rpb25hbCBjb21wb25lbnQuXG4gICAgY29uc3QgYnVmZmVyID0gbmV3IEFycmF5QnVmZmVyKFxuICAgICAgTWF0aC5tYXgobGVuZ3RoLCAyICogVWludDMyQXJyYXkuQllURVNfUEVSX0VMRU1FTlQpXG4gICAgKTtcblxuICAgIGxldCB2aWV3ID0gbmV3IFVpbnQzMkFycmF5KGJ1ZmZlciwgMCwgMik7XG4gICAgdmlld1swXSA9IHZhbHVlICUgKCgxIDw8IDE2KSAqICgxIDw8IDE2KSkgfCAwO1xuICAgIHZpZXdbMV0gPSB2YWx1ZSAvICgoMSA8PCAxNikgKiAoMSA8PCAxNikpIHwgMDtcblxuICAgIC8vIHNpZ24gZXh0ZW5zaW9uXG4gICAgaWYgKHZhbHVlIDwgMCkge1xuICAgICAgdmlldyA9IG5ldyBVaW50OEFycmF5KGJ1ZmZlciwgMik7XG4gICAgICB2aWV3LmZvckVhY2goKGJ5dGUsIGkpID0+IHtcbiAgICAgICAgdmlld1tpXSA9IDB4ZmY7XG4gICAgICB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gbmV3IFVpbnQ4QXJyYXkoYnVmZmVyKTtcbiAgfVxuXG4gIC8vIGJpbmRhdGFcbiAgaWYgKEVKU09OLmlzQmluYXJ5KHZhbHVlKSkge1xuICAgIHJldHVybiBuZXcgVWludDhBcnJheSh2YWx1ZS5idWZmZXIpO1xuICB9XG5cbiAgLy8gbm8gbWF0Y2hcbiAgcmV0dXJuIGZhbHNlO1xufVxuXG4vLyBBY3R1YWxseSBpbnNlcnRzIGEga2V5IHZhbHVlIGludG8gdGhlIHNlbGVjdG9yIGRvY3VtZW50XG4vLyBIb3dldmVyLCB0aGlzIGNoZWNrcyB0aGVyZSBpcyBubyBhbWJpZ3VpdHkgaW4gc2V0dGluZ1xuLy8gdGhlIHZhbHVlIGZvciB0aGUgZ2l2ZW4ga2V5LCB0aHJvd3Mgb3RoZXJ3aXNlXG5mdW5jdGlvbiBpbnNlcnRJbnRvRG9jdW1lbnQoZG9jdW1lbnQsIGtleSwgdmFsdWUpIHtcbiAgT2JqZWN0LmtleXMoZG9jdW1lbnQpLmZvckVhY2goZXhpc3RpbmdLZXkgPT4ge1xuICAgIGlmIChcbiAgICAgIChleGlzdGluZ0tleS5sZW5ndGggPiBrZXkubGVuZ3RoICYmIGV4aXN0aW5nS2V5LmluZGV4T2YoYCR7a2V5fS5gKSA9PT0gMCkgfHxcbiAgICAgIChrZXkubGVuZ3RoID4gZXhpc3RpbmdLZXkubGVuZ3RoICYmIGtleS5pbmRleE9mKGAke2V4aXN0aW5nS2V5fS5gKSA9PT0gMClcbiAgICApIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgYGNhbm5vdCBpbmZlciBxdWVyeSBmaWVsZHMgdG8gc2V0LCBib3RoIHBhdGhzICcke2V4aXN0aW5nS2V5fScgYW5kIGAgK1xuICAgICAgICBgJyR7a2V5fScgYXJlIG1hdGNoZWRgXG4gICAgICApO1xuICAgIH0gZWxzZSBpZiAoZXhpc3RpbmdLZXkgPT09IGtleSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgY2Fubm90IGluZmVyIHF1ZXJ5IGZpZWxkcyB0byBzZXQsIHBhdGggJyR7a2V5fScgaXMgbWF0Y2hlZCB0d2ljZWBcbiAgICAgICk7XG4gICAgfVxuICB9KTtcblxuICBkb2N1bWVudFtrZXldID0gdmFsdWU7XG59XG5cbi8vIFJldHVybnMgYSBicmFuY2hlZCBtYXRjaGVyIHRoYXQgbWF0Y2hlcyBpZmYgdGhlIGdpdmVuIG1hdGNoZXIgZG9lcyBub3QuXG4vLyBOb3RlIHRoYXQgdGhpcyBpbXBsaWNpdGx5IFwiZGVNb3JnYW5pemVzXCIgdGhlIHdyYXBwZWQgZnVuY3Rpb24uICBpZSwgaXRcbi8vIG1lYW5zIHRoYXQgQUxMIGJyYW5jaCB2YWx1ZXMgbmVlZCB0byBmYWlsIHRvIG1hdGNoIGlubmVyQnJhbmNoZWRNYXRjaGVyLlxuZnVuY3Rpb24gaW52ZXJ0QnJhbmNoZWRNYXRjaGVyKGJyYW5jaGVkTWF0Y2hlcikge1xuICByZXR1cm4gYnJhbmNoVmFsdWVzID0+IHtcbiAgICAvLyBXZSBleHBsaWNpdGx5IGNob29zZSB0byBzdHJpcCBhcnJheUluZGljZXMgaGVyZTogaXQgZG9lc24ndCBtYWtlIHNlbnNlIHRvXG4gICAgLy8gc2F5IFwidXBkYXRlIHRoZSBhcnJheSBlbGVtZW50IHRoYXQgZG9lcyBub3QgbWF0Y2ggc29tZXRoaW5nXCIsIGF0IGxlYXN0XG4gICAgLy8gaW4gbW9uZ28tbGFuZC5cbiAgICByZXR1cm4ge3Jlc3VsdDogIWJyYW5jaGVkTWF0Y2hlcihicmFuY2hWYWx1ZXMpLnJlc3VsdH07XG4gIH07XG59XG5cbmV4cG9ydCBmdW5jdGlvbiBpc0luZGV4YWJsZShvYmopIHtcbiAgcmV0dXJuIEFycmF5LmlzQXJyYXkob2JqKSB8fCBMb2NhbENvbGxlY3Rpb24uX2lzUGxhaW5PYmplY3Qob2JqKTtcbn1cblxuZXhwb3J0IGZ1bmN0aW9uIGlzTnVtZXJpY0tleShzKSB7XG4gIHJldHVybiAvXlswLTldKyQvLnRlc3Qocyk7XG59XG5cbi8vIFJldHVybnMgdHJ1ZSBpZiB0aGlzIGlzIGFuIG9iamVjdCB3aXRoIGF0IGxlYXN0IG9uZSBrZXkgYW5kIGFsbCBrZXlzIGJlZ2luXG4vLyB3aXRoICQuICBVbmxlc3MgaW5jb25zaXN0ZW50T0sgaXMgc2V0LCB0aHJvd3MgaWYgc29tZSBrZXlzIGJlZ2luIHdpdGggJCBhbmRcbi8vIG90aGVycyBkb24ndC5cbmV4cG9ydCBmdW5jdGlvbiBpc09wZXJhdG9yT2JqZWN0KHZhbHVlU2VsZWN0b3IsIGluY29uc2lzdGVudE9LKSB7XG4gIGlmICghTG9jYWxDb2xsZWN0aW9uLl9pc1BsYWluT2JqZWN0KHZhbHVlU2VsZWN0b3IpKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG5cbiAgbGV0IHRoZXNlQXJlT3BlcmF0b3JzID0gdW5kZWZpbmVkO1xuICBPYmplY3Qua2V5cyh2YWx1ZVNlbGVjdG9yKS5mb3JFYWNoKHNlbEtleSA9PiB7XG4gICAgY29uc3QgdGhpc0lzT3BlcmF0b3IgPSBzZWxLZXkuc3Vic3RyKDAsIDEpID09PSAnJCcgfHwgc2VsS2V5ID09PSAnZGlmZic7XG5cbiAgICBpZiAodGhlc2VBcmVPcGVyYXRvcnMgPT09IHVuZGVmaW5lZCkge1xuICAgICAgdGhlc2VBcmVPcGVyYXRvcnMgPSB0aGlzSXNPcGVyYXRvcjtcbiAgICB9IGVsc2UgaWYgKHRoZXNlQXJlT3BlcmF0b3JzICE9PSB0aGlzSXNPcGVyYXRvcikge1xuICAgICAgaWYgKCFpbmNvbnNpc3RlbnRPSykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICAgYEluY29uc2lzdGVudCBvcGVyYXRvcjogJHtKU09OLnN0cmluZ2lmeSh2YWx1ZVNlbGVjdG9yKX1gXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIHRoZXNlQXJlT3BlcmF0b3JzID0gZmFsc2U7XG4gICAgfVxuICB9KTtcblxuICByZXR1cm4gISF0aGVzZUFyZU9wZXJhdG9yczsgLy8ge30gaGFzIG5vIG9wZXJhdG9yc1xufVxuXG4vLyBIZWxwZXIgZm9yICRsdC8kZ3QvJGx0ZS8kZ3RlLlxuZnVuY3Rpb24gbWFrZUluZXF1YWxpdHkoY21wVmFsdWVDb21wYXJhdG9yKSB7XG4gIHJldHVybiB7XG4gICAgY29tcGlsZUVsZW1lbnRTZWxlY3RvcihvcGVyYW5kKSB7XG4gICAgICAvLyBBcnJheXMgbmV2ZXIgY29tcGFyZSBmYWxzZSB3aXRoIG5vbi1hcnJheXMgZm9yIGFueSBpbmVxdWFsaXR5LlxuICAgICAgLy8gWFhYIFRoaXMgd2FzIGJlaGF2aW9yIHdlIG9ic2VydmVkIGluIHByZS1yZWxlYXNlIE1vbmdvREIgMi41LCBidXRcbiAgICAgIC8vICAgICBpdCBzZWVtcyB0byBoYXZlIGJlZW4gcmV2ZXJ0ZWQuXG4gICAgICAvLyAgICAgU2VlIGh0dHBzOi8vamlyYS5tb25nb2RiLm9yZy9icm93c2UvU0VSVkVSLTExNDQ0XG4gICAgICBpZiAoQXJyYXkuaXNBcnJheShvcGVyYW5kKSkge1xuICAgICAgICByZXR1cm4gKCkgPT4gZmFsc2U7XG4gICAgICB9XG5cbiAgICAgIC8vIFNwZWNpYWwgY2FzZTogY29uc2lkZXIgdW5kZWZpbmVkIGFuZCBudWxsIHRoZSBzYW1lIChzbyB0cnVlIHdpdGhcbiAgICAgIC8vICRndGUvJGx0ZSkuXG4gICAgICBpZiAob3BlcmFuZCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIG9wZXJhbmQgPSBudWxsO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBvcGVyYW5kVHlwZSA9IExvY2FsQ29sbGVjdGlvbi5fZi5fdHlwZShvcGVyYW5kKTtcblxuICAgICAgcmV0dXJuIHZhbHVlID0+IHtcbiAgICAgICAgaWYgKHZhbHVlID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICB2YWx1ZSA9IG51bGw7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBDb21wYXJpc29ucyBhcmUgbmV2ZXIgdHJ1ZSBhbW9uZyB0aGluZ3Mgb2YgZGlmZmVyZW50IHR5cGUgKGV4Y2VwdFxuICAgICAgICAvLyBudWxsIHZzIHVuZGVmaW5lZCkuXG4gICAgICAgIGlmIChMb2NhbENvbGxlY3Rpb24uX2YuX3R5cGUodmFsdWUpICE9PSBvcGVyYW5kVHlwZSkge1xuICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjbXBWYWx1ZUNvbXBhcmF0b3IoTG9jYWxDb2xsZWN0aW9uLl9mLl9jbXAodmFsdWUsIG9wZXJhbmQpKTtcbiAgICAgIH07XG4gICAgfSxcbiAgfTtcbn1cblxuLy8gbWFrZUxvb2t1cEZ1bmN0aW9uKGtleSkgcmV0dXJucyBhIGxvb2t1cCBmdW5jdGlvbi5cbi8vXG4vLyBBIGxvb2t1cCBmdW5jdGlvbiB0YWtlcyBpbiBhIGRvY3VtZW50IGFuZCByZXR1cm5zIGFuIGFycmF5IG9mIG1hdGNoaW5nXG4vLyBicmFuY2hlcy4gIElmIG5vIGFycmF5cyBhcmUgZm91bmQgd2hpbGUgbG9va2luZyB1cCB0aGUga2V5LCB0aGlzIGFycmF5IHdpbGxcbi8vIGhhdmUgZXhhY3RseSBvbmUgYnJhbmNoZXMgKHBvc3NpYmx5ICd1bmRlZmluZWQnLCBpZiBzb21lIHNlZ21lbnQgb2YgdGhlIGtleVxuLy8gd2FzIG5vdCBmb3VuZCkuXG4vL1xuLy8gSWYgYXJyYXlzIGFyZSBmb3VuZCBpbiB0aGUgbWlkZGxlLCB0aGlzIGNhbiBoYXZlIG1vcmUgdGhhbiBvbmUgZWxlbWVudCwgc2luY2Vcbi8vIHdlICdicmFuY2gnLiBXaGVuIHdlICdicmFuY2gnLCBpZiB0aGVyZSBhcmUgbW9yZSBrZXkgc2VnbWVudHMgdG8gbG9vayB1cCxcbi8vIHRoZW4gd2Ugb25seSBwdXJzdWUgYnJhbmNoZXMgdGhhdCBhcmUgcGxhaW4gb2JqZWN0cyAobm90IGFycmF5cyBvciBzY2FsYXJzKS5cbi8vIFRoaXMgbWVhbnMgd2UgY2FuIGFjdHVhbGx5IGVuZCB1cCB3aXRoIG5vIGJyYW5jaGVzIVxuLy9cbi8vIFdlIGRvICpOT1QqIGJyYW5jaCBvbiBhcnJheXMgdGhhdCBhcmUgZm91bmQgYXQgdGhlIGVuZCAoaWUsIGF0IHRoZSBsYXN0XG4vLyBkb3R0ZWQgbWVtYmVyIG9mIHRoZSBrZXkpLiBXZSBqdXN0IHJldHVybiB0aGF0IGFycmF5OyBpZiB5b3Ugd2FudCB0b1xuLy8gZWZmZWN0aXZlbHkgJ2JyYW5jaCcgb3ZlciB0aGUgYXJyYXkncyB2YWx1ZXMsIHBvc3QtcHJvY2VzcyB0aGUgbG9va3VwXG4vLyBmdW5jdGlvbiB3aXRoIGV4cGFuZEFycmF5c0luQnJhbmNoZXMuXG4vL1xuLy8gRWFjaCBicmFuY2ggaXMgYW4gb2JqZWN0IHdpdGgga2V5czpcbi8vICAtIHZhbHVlOiB0aGUgdmFsdWUgYXQgdGhlIGJyYW5jaFxuLy8gIC0gZG9udEl0ZXJhdGU6IGFuIG9wdGlvbmFsIGJvb2w7IGlmIHRydWUsIGl0IG1lYW5zIHRoYXQgJ3ZhbHVlJyBpcyBhbiBhcnJheVxuLy8gICAgdGhhdCBleHBhbmRBcnJheXNJbkJyYW5jaGVzIHNob3VsZCBOT1QgZXhwYW5kLiBUaGlzIHNwZWNpZmljYWxseSBoYXBwZW5zXG4vLyAgICB3aGVuIHRoZXJlIGlzIGEgbnVtZXJpYyBpbmRleCBpbiB0aGUga2V5LCBhbmQgZW5zdXJlcyB0aGVcbi8vICAgIHBlcmhhcHMtc3VycHJpc2luZyBNb25nb0RCIGJlaGF2aW9yIHdoZXJlIHsnYS4wJzogNX0gZG9lcyBOT1Rcbi8vICAgIG1hdGNoIHthOiBbWzVdXX0uXG4vLyAgLSBhcnJheUluZGljZXM6IGlmIGFueSBhcnJheSBpbmRleGluZyB3YXMgZG9uZSBkdXJpbmcgbG9va3VwIChlaXRoZXIgZHVlIHRvXG4vLyAgICBleHBsaWNpdCBudW1lcmljIGluZGljZXMgb3IgaW1wbGljaXQgYnJhbmNoaW5nKSwgdGhpcyB3aWxsIGJlIGFuIGFycmF5IG9mXG4vLyAgICB0aGUgYXJyYXkgaW5kaWNlcyB1c2VkLCBmcm9tIG91dGVybW9zdCB0byBpbm5lcm1vc3Q7IGl0IGlzIGZhbHNleSBvclxuLy8gICAgYWJzZW50IGlmIG5vIGFycmF5IGluZGV4IGlzIHVzZWQuIElmIGFuIGV4cGxpY2l0IG51bWVyaWMgaW5kZXggaXMgdXNlZCxcbi8vICAgIHRoZSBpbmRleCB3aWxsIGJlIGZvbGxvd2VkIGluIGFycmF5SW5kaWNlcyBieSB0aGUgc3RyaW5nICd4Jy5cbi8vXG4vLyAgICBOb3RlOiBhcnJheUluZGljZXMgaXMgdXNlZCBmb3IgdHdvIHB1cnBvc2VzLiBGaXJzdCwgaXQgaXMgdXNlZCB0b1xuLy8gICAgaW1wbGVtZW50IHRoZSAnJCcgbW9kaWZpZXIgZmVhdHVyZSwgd2hpY2ggb25seSBldmVyIGxvb2tzIGF0IGl0cyBmaXJzdFxuLy8gICAgZWxlbWVudC5cbi8vXG4vLyAgICBTZWNvbmQsIGl0IGlzIHVzZWQgZm9yIHNvcnQga2V5IGdlbmVyYXRpb24sIHdoaWNoIG5lZWRzIHRvIGJlIGFibGUgdG8gdGVsbFxuLy8gICAgdGhlIGRpZmZlcmVuY2UgYmV0d2VlbiBkaWZmZXJlbnQgcGF0aHMuIE1vcmVvdmVyLCBpdCBuZWVkcyB0b1xuLy8gICAgZGlmZmVyZW50aWF0ZSBiZXR3ZWVuIGV4cGxpY2l0IGFuZCBpbXBsaWNpdCBicmFuY2hpbmcsIHdoaWNoIGlzIHdoeVxuLy8gICAgdGhlcmUncyB0aGUgc29tZXdoYXQgaGFja3kgJ3gnIGVudHJ5OiB0aGlzIG1lYW5zIHRoYXQgZXhwbGljaXQgYW5kXG4vLyAgICBpbXBsaWNpdCBhcnJheSBsb29rdXBzIHdpbGwgaGF2ZSBkaWZmZXJlbnQgZnVsbCBhcnJheUluZGljZXMgcGF0aHMuIChUaGF0XG4vLyAgICBjb2RlIG9ubHkgcmVxdWlyZXMgdGhhdCBkaWZmZXJlbnQgcGF0aHMgaGF2ZSBkaWZmZXJlbnQgYXJyYXlJbmRpY2VzOyBpdFxuLy8gICAgZG9lc24ndCBhY3R1YWxseSAncGFyc2UnIGFycmF5SW5kaWNlcy4gQXMgYW4gYWx0ZXJuYXRpdmUsIGFycmF5SW5kaWNlc1xuLy8gICAgY291bGQgY29udGFpbiBvYmplY3RzIHdpdGggZmxhZ3MgbGlrZSAnaW1wbGljaXQnLCBidXQgSSB0aGluayB0aGF0IG9ubHlcbi8vICAgIG1ha2VzIHRoZSBjb2RlIHN1cnJvdW5kaW5nIHRoZW0gbW9yZSBjb21wbGV4Lilcbi8vXG4vLyAgICAoQnkgdGhlIHdheSwgdGhpcyBmaWVsZCBlbmRzIHVwIGdldHRpbmcgcGFzc2VkIGFyb3VuZCBhIGxvdCB3aXRob3V0XG4vLyAgICBjbG9uaW5nLCBzbyBuZXZlciBtdXRhdGUgYW55IGFycmF5SW5kaWNlcyBmaWVsZC92YXIgaW4gdGhpcyBwYWNrYWdlISlcbi8vXG4vL1xuLy8gQXQgdGhlIHRvcCBsZXZlbCwgeW91IG1heSBvbmx5IHBhc3MgaW4gYSBwbGFpbiBvYmplY3Qgb3IgYXJyYXkuXG4vL1xuLy8gU2VlIHRoZSB0ZXN0ICdtaW5pbW9uZ28gLSBsb29rdXAnIGZvciBzb21lIGV4YW1wbGVzIG9mIHdoYXQgbG9va3VwIGZ1bmN0aW9uc1xuLy8gcmV0dXJuLlxuZXhwb3J0IGZ1bmN0aW9uIG1ha2VMb29rdXBGdW5jdGlvbihrZXksIG9wdGlvbnMgPSB7fSkge1xuICBjb25zdCBwYXJ0cyA9IGtleS5zcGxpdCgnLicpO1xuICBjb25zdCBmaXJzdFBhcnQgPSBwYXJ0cy5sZW5ndGggPyBwYXJ0c1swXSA6ICcnO1xuICBjb25zdCBsb29rdXBSZXN0ID0gKFxuICAgIHBhcnRzLmxlbmd0aCA+IDEgJiZcbiAgICBtYWtlTG9va3VwRnVuY3Rpb24ocGFydHMuc2xpY2UoMSkuam9pbignLicpLCBvcHRpb25zKVxuICApO1xuXG4gIGNvbnN0IG9taXRVbm5lY2Vzc2FyeUZpZWxkcyA9IHJlc3VsdCA9PiB7XG4gICAgaWYgKCFyZXN1bHQuZG9udEl0ZXJhdGUpIHtcbiAgICAgIGRlbGV0ZSByZXN1bHQuZG9udEl0ZXJhdGU7XG4gICAgfVxuXG4gICAgaWYgKHJlc3VsdC5hcnJheUluZGljZXMgJiYgIXJlc3VsdC5hcnJheUluZGljZXMubGVuZ3RoKSB7XG4gICAgICBkZWxldGUgcmVzdWx0LmFycmF5SW5kaWNlcztcbiAgICB9XG5cbiAgICByZXR1cm4gcmVzdWx0O1xuICB9O1xuXG4gIC8vIERvYyB3aWxsIGFsd2F5cyBiZSBhIHBsYWluIG9iamVjdCBvciBhbiBhcnJheS5cbiAgLy8gYXBwbHkgYW4gZXhwbGljaXQgbnVtZXJpYyBpbmRleCwgYW4gYXJyYXkuXG4gIHJldHVybiAoZG9jLCBhcnJheUluZGljZXMgPSBbXSkgPT4ge1xuICAgIGlmIChBcnJheS5pc0FycmF5KGRvYykpIHtcbiAgICAgIC8vIElmIHdlJ3JlIGJlaW5nIGFza2VkIHRvIGRvIGFuIGludmFsaWQgbG9va3VwIGludG8gYW4gYXJyYXkgKG5vbi1pbnRlZ2VyXG4gICAgICAvLyBvciBvdXQtb2YtYm91bmRzKSwgcmV0dXJuIG5vIHJlc3VsdHMgKHdoaWNoIGlzIGRpZmZlcmVudCBmcm9tIHJldHVybmluZ1xuICAgICAgLy8gYSBzaW5nbGUgdW5kZWZpbmVkIHJlc3VsdCwgaW4gdGhhdCBgbnVsbGAgZXF1YWxpdHkgY2hlY2tzIHdvbid0IG1hdGNoKS5cbiAgICAgIGlmICghKGlzTnVtZXJpY0tleShmaXJzdFBhcnQpICYmIGZpcnN0UGFydCA8IGRvYy5sZW5ndGgpKSB7XG4gICAgICAgIHJldHVybiBbXTtcbiAgICAgIH1cblxuICAgICAgLy8gUmVtZW1iZXIgdGhhdCB3ZSB1c2VkIHRoaXMgYXJyYXkgaW5kZXguIEluY2x1ZGUgYW4gJ3gnIHRvIGluZGljYXRlIHRoYXRcbiAgICAgIC8vIHRoZSBwcmV2aW91cyBpbmRleCBjYW1lIGZyb20gYmVpbmcgY29uc2lkZXJlZCBhcyBhbiBleHBsaWNpdCBhcnJheVxuICAgICAgLy8gaW5kZXggKG5vdCBicmFuY2hpbmcpLlxuICAgICAgYXJyYXlJbmRpY2VzID0gYXJyYXlJbmRpY2VzLmNvbmNhdCgrZmlyc3RQYXJ0LCAneCcpO1xuICAgIH1cblxuICAgIC8vIERvIG91ciBmaXJzdCBsb29rdXAuXG4gICAgY29uc3QgZmlyc3RMZXZlbCA9IGRvY1tmaXJzdFBhcnRdO1xuXG4gICAgLy8gSWYgdGhlcmUgaXMgbm8gZGVlcGVyIHRvIGRpZywgcmV0dXJuIHdoYXQgd2UgZm91bmQuXG4gICAgLy9cbiAgICAvLyBJZiB3aGF0IHdlIGZvdW5kIGlzIGFuIGFycmF5LCBtb3N0IHZhbHVlIHNlbGVjdG9ycyB3aWxsIGNob29zZSB0byB0cmVhdFxuICAgIC8vIHRoZSBlbGVtZW50cyBvZiB0aGUgYXJyYXkgYXMgbWF0Y2hhYmxlIHZhbHVlcyBpbiB0aGVpciBvd24gcmlnaHQsIGJ1dFxuICAgIC8vIHRoYXQncyBkb25lIG91dHNpZGUgb2YgdGhlIGxvb2t1cCBmdW5jdGlvbi4gKEV4Y2VwdGlvbnMgdG8gdGhpcyBhcmUgJHNpemVcbiAgICAvLyBhbmQgc3R1ZmYgcmVsYXRpbmcgdG8gJGVsZW1NYXRjaC4gIGVnLCB7YTogeyRzaXplOiAyfX0gZG9lcyBub3QgbWF0Y2gge2E6XG4gICAgLy8gW1sxLCAyXV19LilcbiAgICAvL1xuICAgIC8vIFRoYXQgc2FpZCwgaWYgd2UganVzdCBkaWQgYW4gKmV4cGxpY2l0KiBhcnJheSBsb29rdXAgKG9uIGRvYykgdG8gZmluZFxuICAgIC8vIGZpcnN0TGV2ZWwsIGFuZCBmaXJzdExldmVsIGlzIGFuIGFycmF5IHRvbywgd2UgZG8gTk9UIHdhbnQgdmFsdWVcbiAgICAvLyBzZWxlY3RvcnMgdG8gaXRlcmF0ZSBvdmVyIGl0LiAgZWcsIHsnYS4wJzogNX0gZG9lcyBub3QgbWF0Y2gge2E6IFtbNV1dfS5cbiAgICAvLyBTbyBpbiB0aGF0IGNhc2UsIHdlIG1hcmsgdGhlIHJldHVybiB2YWx1ZSBhcyAnZG9uJ3QgaXRlcmF0ZScuXG4gICAgaWYgKCFsb29rdXBSZXN0KSB7XG4gICAgICByZXR1cm4gW29taXRVbm5lY2Vzc2FyeUZpZWxkcyh7XG4gICAgICAgIGFycmF5SW5kaWNlcyxcbiAgICAgICAgZG9udEl0ZXJhdGU6IEFycmF5LmlzQXJyYXkoZG9jKSAmJiBBcnJheS5pc0FycmF5KGZpcnN0TGV2ZWwpLFxuICAgICAgICB2YWx1ZTogZmlyc3RMZXZlbFxuICAgICAgfSldO1xuICAgIH1cblxuICAgIC8vIFdlIG5lZWQgdG8gZGlnIGRlZXBlci4gIEJ1dCBpZiB3ZSBjYW4ndCwgYmVjYXVzZSB3aGF0IHdlJ3ZlIGZvdW5kIGlzIG5vdFxuICAgIC8vIGFuIGFycmF5IG9yIHBsYWluIG9iamVjdCwgd2UncmUgZG9uZS4gSWYgd2UganVzdCBkaWQgYSBudW1lcmljIGluZGV4IGludG9cbiAgICAvLyBhbiBhcnJheSwgd2UgcmV0dXJuIG5vdGhpbmcgaGVyZSAodGhpcyBpcyBhIGNoYW5nZSBpbiBNb25nbyAyLjUgZnJvbVxuICAgIC8vIE1vbmdvIDIuNCwgd2hlcmUgeydhLjAuYic6IG51bGx9IHN0b3BwZWQgbWF0Y2hpbmcge2E6IFs1XX0pLiBPdGhlcndpc2UsXG4gICAgLy8gcmV0dXJuIGEgc2luZ2xlIGB1bmRlZmluZWRgICh3aGljaCBjYW4sIGZvciBleGFtcGxlLCBtYXRjaCB2aWEgZXF1YWxpdHlcbiAgICAvLyB3aXRoIGBudWxsYCkuXG4gICAgaWYgKCFpc0luZGV4YWJsZShmaXJzdExldmVsKSkge1xuICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZG9jKSkge1xuICAgICAgICByZXR1cm4gW107XG4gICAgICB9XG5cbiAgICAgIHJldHVybiBbb21pdFVubmVjZXNzYXJ5RmllbGRzKHthcnJheUluZGljZXMsIHZhbHVlOiB1bmRlZmluZWR9KV07XG4gICAgfVxuXG4gICAgY29uc3QgcmVzdWx0ID0gW107XG4gICAgY29uc3QgYXBwZW5kVG9SZXN1bHQgPSBtb3JlID0+IHtcbiAgICAgIHJlc3VsdC5wdXNoKC4uLm1vcmUpO1xuICAgIH07XG5cbiAgICAvLyBEaWcgZGVlcGVyOiBsb29rIHVwIHRoZSByZXN0IG9mIHRoZSBwYXJ0cyBvbiB3aGF0ZXZlciB3ZSd2ZSBmb3VuZC5cbiAgICAvLyAobG9va3VwUmVzdCBpcyBzbWFydCBlbm91Z2ggdG8gbm90IHRyeSB0byBkbyBpbnZhbGlkIGxvb2t1cHMgaW50b1xuICAgIC8vIGZpcnN0TGV2ZWwgaWYgaXQncyBhbiBhcnJheS4pXG4gICAgYXBwZW5kVG9SZXN1bHQobG9va3VwUmVzdChmaXJzdExldmVsLCBhcnJheUluZGljZXMpKTtcblxuICAgIC8vIElmIHdlIGZvdW5kIGFuIGFycmF5LCB0aGVuIGluICphZGRpdGlvbiogdG8gcG90ZW50aWFsbHkgdHJlYXRpbmcgdGhlIG5leHRcbiAgICAvLyBwYXJ0IGFzIGEgbGl0ZXJhbCBpbnRlZ2VyIGxvb2t1cCwgd2Ugc2hvdWxkIGFsc28gJ2JyYW5jaCc6IHRyeSB0byBsb29rIHVwXG4gICAgLy8gdGhlIHJlc3Qgb2YgdGhlIHBhcnRzIG9uIGVhY2ggYXJyYXkgZWxlbWVudCBpbiBwYXJhbGxlbC5cbiAgICAvL1xuICAgIC8vIEluIHRoaXMgY2FzZSwgd2UgKm9ubHkqIGRpZyBkZWVwZXIgaW50byBhcnJheSBlbGVtZW50cyB0aGF0IGFyZSBwbGFpblxuICAgIC8vIG9iamVjdHMuIChSZWNhbGwgdGhhdCB3ZSBvbmx5IGdvdCB0aGlzIGZhciBpZiB3ZSBoYXZlIGZ1cnRoZXIgdG8gZGlnLilcbiAgICAvLyBUaGlzIG1ha2VzIHNlbnNlOiB3ZSBjZXJ0YWlubHkgZG9uJ3QgZGlnIGRlZXBlciBpbnRvIG5vbi1pbmRleGFibGVcbiAgICAvLyBvYmplY3RzLiBBbmQgaXQgd291bGQgYmUgd2VpcmQgdG8gZGlnIGludG8gYW4gYXJyYXk6IGl0J3Mgc2ltcGxlciB0byBoYXZlXG4gICAgLy8gYSBydWxlIHRoYXQgZXhwbGljaXQgaW50ZWdlciBpbmRleGVzIG9ubHkgYXBwbHkgdG8gYW4gb3V0ZXIgYXJyYXksIG5vdCB0b1xuICAgIC8vIGFuIGFycmF5IHlvdSBmaW5kIGFmdGVyIGEgYnJhbmNoaW5nIHNlYXJjaC5cbiAgICAvL1xuICAgIC8vIEluIHRoZSBzcGVjaWFsIGNhc2Ugb2YgYSBudW1lcmljIHBhcnQgaW4gYSAqc29ydCBzZWxlY3RvciogKG5vdCBhIHF1ZXJ5XG4gICAgLy8gc2VsZWN0b3IpLCB3ZSBza2lwIHRoZSBicmFuY2hpbmc6IHdlIE9OTFkgYWxsb3cgdGhlIG51bWVyaWMgcGFydCB0byBtZWFuXG4gICAgLy8gJ2xvb2sgdXAgdGhpcyBpbmRleCcgaW4gdGhhdCBjYXNlLCBub3QgJ2Fsc28gbG9vayB1cCB0aGlzIGluZGV4IGluIGFsbFxuICAgIC8vIHRoZSBlbGVtZW50cyBvZiB0aGUgYXJyYXknLlxuICAgIGlmIChBcnJheS5pc0FycmF5KGZpcnN0TGV2ZWwpICYmXG4gICAgICAgICEoaXNOdW1lcmljS2V5KHBhcnRzWzFdKSAmJiBvcHRpb25zLmZvclNvcnQpKSB7XG4gICAgICBmaXJzdExldmVsLmZvckVhY2goKGJyYW5jaCwgYXJyYXlJbmRleCkgPT4ge1xuICAgICAgICBpZiAoTG9jYWxDb2xsZWN0aW9uLl9pc1BsYWluT2JqZWN0KGJyYW5jaCkpIHtcbiAgICAgICAgICBhcHBlbmRUb1Jlc3VsdChsb29rdXBSZXN0KGJyYW5jaCwgYXJyYXlJbmRpY2VzLmNvbmNhdChhcnJheUluZGV4KSkpO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gcmVzdWx0O1xuICB9O1xufVxuXG4vLyBPYmplY3QgZXhwb3J0ZWQgb25seSBmb3IgdW5pdCB0ZXN0aW5nLlxuLy8gVXNlIGl0IHRvIGV4cG9ydCBwcml2YXRlIGZ1bmN0aW9ucyB0byB0ZXN0IGluIFRpbnl0ZXN0LlxuTWluaW1vbmdvVGVzdCA9IHttYWtlTG9va3VwRnVuY3Rpb259O1xuTWluaW1vbmdvRXJyb3IgPSAobWVzc2FnZSwgb3B0aW9ucyA9IHt9KSA9PiB7XG4gIGlmICh0eXBlb2YgbWVzc2FnZSA9PT0gJ3N0cmluZycgJiYgb3B0aW9ucy5maWVsZCkge1xuICAgIG1lc3NhZ2UgKz0gYCBmb3IgZmllbGQgJyR7b3B0aW9ucy5maWVsZH0nYDtcbiAgfVxuXG4gIGNvbnN0IGVycm9yID0gbmV3IEVycm9yKG1lc3NhZ2UpO1xuICBlcnJvci5uYW1lID0gJ01pbmltb25nb0Vycm9yJztcbiAgcmV0dXJuIGVycm9yO1xufTtcblxuZXhwb3J0IGZ1bmN0aW9uIG5vdGhpbmdNYXRjaGVyKGRvY09yQnJhbmNoZWRWYWx1ZXMpIHtcbiAgcmV0dXJuIHtyZXN1bHQ6IGZhbHNlfTtcbn1cblxuLy8gVGFrZXMgYW4gb3BlcmF0b3Igb2JqZWN0IChhbiBvYmplY3Qgd2l0aCAkIGtleXMpIGFuZCByZXR1cm5zIGEgYnJhbmNoZWRcbi8vIG1hdGNoZXIgZm9yIGl0LlxuZnVuY3Rpb24gb3BlcmF0b3JCcmFuY2hlZE1hdGNoZXIodmFsdWVTZWxlY3RvciwgbWF0Y2hlciwgaXNSb290KSB7XG4gIC8vIEVhY2ggdmFsdWVTZWxlY3RvciB3b3JrcyBzZXBhcmF0ZWx5IG9uIHRoZSB2YXJpb3VzIGJyYW5jaGVzLiAgU28gb25lXG4gIC8vIG9wZXJhdG9yIGNhbiBtYXRjaCBvbmUgYnJhbmNoIGFuZCBhbm90aGVyIGNhbiBtYXRjaCBhbm90aGVyIGJyYW5jaC4gIFRoaXNcbiAgLy8gaXMgT0suXG4gIGNvbnN0IG9wZXJhdG9yTWF0Y2hlcnMgPSBPYmplY3Qua2V5cyh2YWx1ZVNlbGVjdG9yKS5tYXAob3BlcmF0b3IgPT4ge1xuICAgIGNvbnN0IG9wZXJhbmQgPSB2YWx1ZVNlbGVjdG9yW29wZXJhdG9yXTtcblxuICAgIGNvbnN0IHNpbXBsZVJhbmdlID0gKFxuICAgICAgWyckbHQnLCAnJGx0ZScsICckZ3QnLCAnJGd0ZSddLmluY2x1ZGVzKG9wZXJhdG9yKSAmJlxuICAgICAgdHlwZW9mIG9wZXJhbmQgPT09ICdudW1iZXInXG4gICAgKTtcblxuICAgIGNvbnN0IHNpbXBsZUVxdWFsaXR5ID0gKFxuICAgICAgWyckbmUnLCAnJGVxJ10uaW5jbHVkZXMob3BlcmF0b3IpICYmXG4gICAgICBvcGVyYW5kICE9PSBPYmplY3Qob3BlcmFuZClcbiAgICApO1xuXG4gICAgY29uc3Qgc2ltcGxlSW5jbHVzaW9uID0gKFxuICAgICAgWyckaW4nLCAnJG5pbiddLmluY2x1ZGVzKG9wZXJhdG9yKVxuICAgICAgJiYgQXJyYXkuaXNBcnJheShvcGVyYW5kKVxuICAgICAgJiYgIW9wZXJhbmQuc29tZSh4ID0+IHggPT09IE9iamVjdCh4KSlcbiAgICApO1xuXG4gICAgaWYgKCEoc2ltcGxlUmFuZ2UgfHwgc2ltcGxlSW5jbHVzaW9uIHx8IHNpbXBsZUVxdWFsaXR5KSkge1xuICAgICAgbWF0Y2hlci5faXNTaW1wbGUgPSBmYWxzZTtcbiAgICB9XG5cbiAgICBpZiAoaGFzT3duLmNhbGwoVkFMVUVfT1BFUkFUT1JTLCBvcGVyYXRvcikpIHtcbiAgICAgIHJldHVybiBWQUxVRV9PUEVSQVRPUlNbb3BlcmF0b3JdKG9wZXJhbmQsIHZhbHVlU2VsZWN0b3IsIG1hdGNoZXIsIGlzUm9vdCk7XG4gICAgfVxuXG4gICAgaWYgKGhhc093bi5jYWxsKEVMRU1FTlRfT1BFUkFUT1JTLCBvcGVyYXRvcikpIHtcbiAgICAgIGNvbnN0IG9wdGlvbnMgPSBFTEVNRU5UX09QRVJBVE9SU1tvcGVyYXRvcl07XG4gICAgICByZXR1cm4gY29udmVydEVsZW1lbnRNYXRjaGVyVG9CcmFuY2hlZE1hdGNoZXIoXG4gICAgICAgIG9wdGlvbnMuY29tcGlsZUVsZW1lbnRTZWxlY3RvcihvcGVyYW5kLCB2YWx1ZVNlbGVjdG9yLCBtYXRjaGVyKSxcbiAgICAgICAgb3B0aW9uc1xuICAgICAgKTtcbiAgICB9XG5cbiAgICB0aHJvdyBuZXcgRXJyb3IoYFVucmVjb2duaXplZCBvcGVyYXRvcjogJHtvcGVyYXRvcn1gKTtcbiAgfSk7XG5cbiAgcmV0dXJuIGFuZEJyYW5jaGVkTWF0Y2hlcnMob3BlcmF0b3JNYXRjaGVycyk7XG59XG5cbi8vIHBhdGhzIC0gQXJyYXk6IGxpc3Qgb2YgbW9uZ28gc3R5bGUgcGF0aHNcbi8vIG5ld0xlYWZGbiAtIEZ1bmN0aW9uOiBvZiBmb3JtIGZ1bmN0aW9uKHBhdGgpIHNob3VsZCByZXR1cm4gYSBzY2FsYXIgdmFsdWUgdG9cbi8vICAgICAgICAgICAgICAgICAgICAgICBwdXQgaW50byBsaXN0IGNyZWF0ZWQgZm9yIHRoYXQgcGF0aFxuLy8gY29uZmxpY3RGbiAtIEZ1bmN0aW9uOiBvZiBmb3JtIGZ1bmN0aW9uKG5vZGUsIHBhdGgsIGZ1bGxQYXRoKSBpcyBjYWxsZWRcbi8vICAgICAgICAgICAgICAgICAgICAgICAgd2hlbiBidWlsZGluZyBhIHRyZWUgcGF0aCBmb3IgJ2Z1bGxQYXRoJyBub2RlIG9uXG4vLyAgICAgICAgICAgICAgICAgICAgICAgICdwYXRoJyB3YXMgYWxyZWFkeSBhIGxlYWYgd2l0aCBhIHZhbHVlLiBNdXN0IHJldHVybiBhXG4vLyAgICAgICAgICAgICAgICAgICAgICAgIGNvbmZsaWN0IHJlc29sdXRpb24uXG4vLyBpbml0aWFsIHRyZWUgLSBPcHRpb25hbCBPYmplY3Q6IHN0YXJ0aW5nIHRyZWUuXG4vLyBAcmV0dXJucyAtIE9iamVjdDogdHJlZSByZXByZXNlbnRlZCBhcyBhIHNldCBvZiBuZXN0ZWQgb2JqZWN0c1xuZXhwb3J0IGZ1bmN0aW9uIHBhdGhzVG9UcmVlKHBhdGhzLCBuZXdMZWFmRm4sIGNvbmZsaWN0Rm4sIHJvb3QgPSB7fSkge1xuICBwYXRocy5mb3JFYWNoKHBhdGggPT4ge1xuICAgIGNvbnN0IHBhdGhBcnJheSA9IHBhdGguc3BsaXQoJy4nKTtcbiAgICBsZXQgdHJlZSA9IHJvb3Q7XG5cbiAgICAvLyB1c2UgLmV2ZXJ5IGp1c3QgZm9yIGl0ZXJhdGlvbiB3aXRoIGJyZWFrXG4gICAgY29uc3Qgc3VjY2VzcyA9IHBhdGhBcnJheS5zbGljZSgwLCAtMSkuZXZlcnkoKGtleSwgaSkgPT4ge1xuICAgICAgaWYgKCFoYXNPd24uY2FsbCh0cmVlLCBrZXkpKSB7XG4gICAgICAgIHRyZWVba2V5XSA9IHt9O1xuICAgICAgfSBlbHNlIGlmICh0cmVlW2tleV0gIT09IE9iamVjdCh0cmVlW2tleV0pKSB7XG4gICAgICAgIHRyZWVba2V5XSA9IGNvbmZsaWN0Rm4oXG4gICAgICAgICAgdHJlZVtrZXldLFxuICAgICAgICAgIHBhdGhBcnJheS5zbGljZSgwLCBpICsgMSkuam9pbignLicpLFxuICAgICAgICAgIHBhdGhcbiAgICAgICAgKTtcblxuICAgICAgICAvLyBicmVhayBvdXQgb2YgbG9vcCBpZiB3ZSBhcmUgZmFpbGluZyBmb3IgdGhpcyBwYXRoXG4gICAgICAgIGlmICh0cmVlW2tleV0gIT09IE9iamVjdCh0cmVlW2tleV0pKSB7XG4gICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIHRyZWUgPSB0cmVlW2tleV07XG5cbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH0pO1xuXG4gICAgaWYgKHN1Y2Nlc3MpIHtcbiAgICAgIGNvbnN0IGxhc3RLZXkgPSBwYXRoQXJyYXlbcGF0aEFycmF5Lmxlbmd0aCAtIDFdO1xuICAgICAgaWYgKGhhc093bi5jYWxsKHRyZWUsIGxhc3RLZXkpKSB7XG4gICAgICAgIHRyZWVbbGFzdEtleV0gPSBjb25mbGljdEZuKHRyZWVbbGFzdEtleV0sIHBhdGgsIHBhdGgpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgdHJlZVtsYXN0S2V5XSA9IG5ld0xlYWZGbihwYXRoKTtcbiAgICAgIH1cbiAgICB9XG4gIH0pO1xuXG4gIHJldHVybiByb290O1xufVxuXG4vLyBNYWtlcyBzdXJlIHdlIGdldCAyIGVsZW1lbnRzIGFycmF5IGFuZCBhc3N1bWUgdGhlIGZpcnN0IG9uZSB0byBiZSB4IGFuZFxuLy8gdGhlIHNlY29uZCBvbmUgdG8geSBubyBtYXR0ZXIgd2hhdCB1c2VyIHBhc3Nlcy5cbi8vIEluIGNhc2UgdXNlciBwYXNzZXMgeyBsb246IHgsIGxhdDogeSB9IHJldHVybnMgW3gsIHldXG5mdW5jdGlvbiBwb2ludFRvQXJyYXkocG9pbnQpIHtcbiAgcmV0dXJuIEFycmF5LmlzQXJyYXkocG9pbnQpID8gcG9pbnQuc2xpY2UoKSA6IFtwb2ludC54LCBwb2ludC55XTtcbn1cblxuLy8gQ3JlYXRpbmcgYSBkb2N1bWVudCBmcm9tIGFuIHVwc2VydCBpcyBxdWl0ZSB0cmlja3kuXG4vLyBFLmcuIHRoaXMgc2VsZWN0b3I6IHtcIiRvclwiOiBbe1wiYi5mb29cIjoge1wiJGFsbFwiOiBbXCJiYXJcIl19fV19LCBzaG91bGQgcmVzdWx0XG4vLyBpbjoge1wiYi5mb29cIjogXCJiYXJcIn1cbi8vIEJ1dCB0aGlzIHNlbGVjdG9yOiB7XCIkb3JcIjogW3tcImJcIjoge1wiZm9vXCI6IHtcIiRhbGxcIjogW1wiYmFyXCJdfX19XX0gc2hvdWxkIHRocm93XG4vLyBhbiBlcnJvclxuXG4vLyBTb21lIHJ1bGVzIChmb3VuZCBtYWlubHkgd2l0aCB0cmlhbCAmIGVycm9yLCBzbyB0aGVyZSBtaWdodCBiZSBtb3JlKTpcbi8vIC0gaGFuZGxlIGFsbCBjaGlsZHMgb2YgJGFuZCAob3IgaW1wbGljaXQgJGFuZClcbi8vIC0gaGFuZGxlICRvciBub2RlcyB3aXRoIGV4YWN0bHkgMSBjaGlsZFxuLy8gLSBpZ25vcmUgJG9yIG5vZGVzIHdpdGggbW9yZSB0aGFuIDEgY2hpbGRcbi8vIC0gaWdub3JlICRub3IgYW5kICRub3Qgbm9kZXNcbi8vIC0gdGhyb3cgd2hlbiBhIHZhbHVlIGNhbiBub3QgYmUgc2V0IHVuYW1iaWd1b3VzbHlcbi8vIC0gZXZlcnkgdmFsdWUgZm9yICRhbGwgc2hvdWxkIGJlIGRlYWx0IHdpdGggYXMgc2VwYXJhdGUgJGVxLXNcbi8vIC0gdGhyZWF0IGFsbCBjaGlsZHJlbiBvZiAkYWxsIGFzICRlcSBzZXR0ZXJzICg9PiBzZXQgaWYgJGFsbC5sZW5ndGggPT09IDEsXG4vLyAgIG90aGVyd2lzZSB0aHJvdyBlcnJvcilcbi8vIC0geW91IGNhbiBub3QgbWl4ICckJy1wcmVmaXhlZCBrZXlzIGFuZCBub24tJyQnLXByZWZpeGVkIGtleXNcbi8vIC0geW91IGNhbiBvbmx5IGhhdmUgZG90dGVkIGtleXMgb24gYSByb290LWxldmVsXG4vLyAtIHlvdSBjYW4gbm90IGhhdmUgJyQnLXByZWZpeGVkIGtleXMgbW9yZSB0aGFuIG9uZS1sZXZlbCBkZWVwIGluIGFuIG9iamVjdFxuXG4vLyBIYW5kbGVzIG9uZSBrZXkvdmFsdWUgcGFpciB0byBwdXQgaW4gdGhlIHNlbGVjdG9yIGRvY3VtZW50XG5mdW5jdGlvbiBwb3B1bGF0ZURvY3VtZW50V2l0aEtleVZhbHVlKGRvY3VtZW50LCBrZXksIHZhbHVlKSB7XG4gIGlmICh2YWx1ZSAmJiBPYmplY3QuZ2V0UHJvdG90eXBlT2YodmFsdWUpID09PSBPYmplY3QucHJvdG90eXBlKSB7XG4gICAgcG9wdWxhdGVEb2N1bWVudFdpdGhPYmplY3QoZG9jdW1lbnQsIGtleSwgdmFsdWUpO1xuICB9IGVsc2UgaWYgKCEodmFsdWUgaW5zdGFuY2VvZiBSZWdFeHApKSB7XG4gICAgaW5zZXJ0SW50b0RvY3VtZW50KGRvY3VtZW50LCBrZXksIHZhbHVlKTtcbiAgfVxufVxuXG4vLyBIYW5kbGVzIGEga2V5LCB2YWx1ZSBwYWlyIHRvIHB1dCBpbiB0aGUgc2VsZWN0b3IgZG9jdW1lbnRcbi8vIGlmIHRoZSB2YWx1ZSBpcyBhbiBvYmplY3RcbmZ1bmN0aW9uIHBvcHVsYXRlRG9jdW1lbnRXaXRoT2JqZWN0KGRvY3VtZW50LCBrZXksIHZhbHVlKSB7XG4gIGNvbnN0IGtleXMgPSBPYmplY3Qua2V5cyh2YWx1ZSk7XG4gIGNvbnN0IHVucHJlZml4ZWRLZXlzID0ga2V5cy5maWx0ZXIob3AgPT4gb3BbMF0gIT09ICckJyk7XG5cbiAgaWYgKHVucHJlZml4ZWRLZXlzLmxlbmd0aCA+IDAgfHwgIWtleXMubGVuZ3RoKSB7XG4gICAgLy8gTGl0ZXJhbCAocG9zc2libHkgZW1wdHkpIG9iamVjdCAoIG9yIGVtcHR5IG9iamVjdCApXG4gICAgLy8gRG9uJ3QgYWxsb3cgbWl4aW5nICckJy1wcmVmaXhlZCB3aXRoIG5vbi0nJCctcHJlZml4ZWQgZmllbGRzXG4gICAgaWYgKGtleXMubGVuZ3RoICE9PSB1bnByZWZpeGVkS2V5cy5sZW5ndGgpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgdW5rbm93biBvcGVyYXRvcjogJHt1bnByZWZpeGVkS2V5c1swXX1gKTtcbiAgICB9XG5cbiAgICB2YWxpZGF0ZU9iamVjdCh2YWx1ZSwga2V5KTtcbiAgICBpbnNlcnRJbnRvRG9jdW1lbnQoZG9jdW1lbnQsIGtleSwgdmFsdWUpO1xuICB9IGVsc2Uge1xuICAgIE9iamVjdC5rZXlzKHZhbHVlKS5mb3JFYWNoKG9wID0+IHtcbiAgICAgIGNvbnN0IG9iamVjdCA9IHZhbHVlW29wXTtcblxuICAgICAgaWYgKG9wID09PSAnJGVxJykge1xuICAgICAgICBwb3B1bGF0ZURvY3VtZW50V2l0aEtleVZhbHVlKGRvY3VtZW50LCBrZXksIG9iamVjdCk7XG4gICAgICB9IGVsc2UgaWYgKG9wID09PSAnJGFsbCcpIHtcbiAgICAgICAgLy8gZXZlcnkgdmFsdWUgZm9yICRhbGwgc2hvdWxkIGJlIGRlYWx0IHdpdGggYXMgc2VwYXJhdGUgJGVxLXNcbiAgICAgICAgb2JqZWN0LmZvckVhY2goZWxlbWVudCA9PlxuICAgICAgICAgIHBvcHVsYXRlRG9jdW1lbnRXaXRoS2V5VmFsdWUoZG9jdW1lbnQsIGtleSwgZWxlbWVudClcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxufVxuXG4vLyBGaWxscyBhIGRvY3VtZW50IHdpdGggY2VydGFpbiBmaWVsZHMgZnJvbSBhbiB1cHNlcnQgc2VsZWN0b3JcbmV4cG9ydCBmdW5jdGlvbiBwb3B1bGF0ZURvY3VtZW50V2l0aFF1ZXJ5RmllbGRzKHF1ZXJ5LCBkb2N1bWVudCA9IHt9KSB7XG4gIGlmIChPYmplY3QuZ2V0UHJvdG90eXBlT2YocXVlcnkpID09PSBPYmplY3QucHJvdG90eXBlKSB7XG4gICAgLy8gaGFuZGxlIGltcGxpY2l0ICRhbmRcbiAgICBPYmplY3Qua2V5cyhxdWVyeSkuZm9yRWFjaChrZXkgPT4ge1xuICAgICAgY29uc3QgdmFsdWUgPSBxdWVyeVtrZXldO1xuXG4gICAgICBpZiAoa2V5ID09PSAnJGFuZCcpIHtcbiAgICAgICAgLy8gaGFuZGxlIGV4cGxpY2l0ICRhbmRcbiAgICAgICAgdmFsdWUuZm9yRWFjaChlbGVtZW50ID0+XG4gICAgICAgICAgcG9wdWxhdGVEb2N1bWVudFdpdGhRdWVyeUZpZWxkcyhlbGVtZW50LCBkb2N1bWVudClcbiAgICAgICAgKTtcbiAgICAgIH0gZWxzZSBpZiAoa2V5ID09PSAnJG9yJykge1xuICAgICAgICAvLyBoYW5kbGUgJG9yIG5vZGVzIHdpdGggZXhhY3RseSAxIGNoaWxkXG4gICAgICAgIGlmICh2YWx1ZS5sZW5ndGggPT09IDEpIHtcbiAgICAgICAgICBwb3B1bGF0ZURvY3VtZW50V2l0aFF1ZXJ5RmllbGRzKHZhbHVlWzBdLCBkb2N1bWVudCk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSBpZiAoa2V5WzBdICE9PSAnJCcpIHtcbiAgICAgICAgLy8gSWdub3JlIG90aGVyICckJy1wcmVmaXhlZCBsb2dpY2FsIHNlbGVjdG9yc1xuICAgICAgICBwb3B1bGF0ZURvY3VtZW50V2l0aEtleVZhbHVlKGRvY3VtZW50LCBrZXksIHZhbHVlKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgfSBlbHNlIHtcbiAgICAvLyBIYW5kbGUgbWV0ZW9yLXNwZWNpZmljIHNob3J0Y3V0IGZvciBzZWxlY3RpbmcgX2lkXG4gICAgaWYgKExvY2FsQ29sbGVjdGlvbi5fc2VsZWN0b3JJc0lkKHF1ZXJ5KSkge1xuICAgICAgaW5zZXJ0SW50b0RvY3VtZW50KGRvY3VtZW50LCAnX2lkJywgcXVlcnkpO1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiBkb2N1bWVudDtcbn1cblxuLy8gVHJhdmVyc2VzIHRoZSBrZXlzIG9mIHBhc3NlZCBwcm9qZWN0aW9uIGFuZCBjb25zdHJ1Y3RzIGEgdHJlZSB3aGVyZSBhbGxcbi8vIGxlYXZlcyBhcmUgZWl0aGVyIGFsbCBUcnVlIG9yIGFsbCBGYWxzZVxuLy8gQHJldHVybnMgT2JqZWN0OlxuLy8gIC0gdHJlZSAtIE9iamVjdCAtIHRyZWUgcmVwcmVzZW50YXRpb24gb2Yga2V5cyBpbnZvbHZlZCBpbiBwcm9qZWN0aW9uXG4vLyAgKGV4Y2VwdGlvbiBmb3IgJ19pZCcgYXMgaXQgaXMgYSBzcGVjaWFsIGNhc2UgaGFuZGxlZCBzZXBhcmF0ZWx5KVxuLy8gIC0gaW5jbHVkaW5nIC0gQm9vbGVhbiAtIFwidGFrZSBvbmx5IGNlcnRhaW4gZmllbGRzXCIgdHlwZSBvZiBwcm9qZWN0aW9uXG5leHBvcnQgZnVuY3Rpb24gcHJvamVjdGlvbkRldGFpbHMoZmllbGRzKSB7XG4gIC8vIEZpbmQgdGhlIG5vbi1faWQga2V5cyAoX2lkIGlzIGhhbmRsZWQgc3BlY2lhbGx5IGJlY2F1c2UgaXQgaXMgaW5jbHVkZWRcbiAgLy8gdW5sZXNzIGV4cGxpY2l0bHkgZXhjbHVkZWQpLiBTb3J0IHRoZSBrZXlzLCBzbyB0aGF0IG91ciBjb2RlIHRvIGRldGVjdFxuICAvLyBvdmVybGFwcyBsaWtlICdmb28nIGFuZCAnZm9vLmJhcicgY2FuIGFzc3VtZSB0aGF0ICdmb28nIGNvbWVzIGZpcnN0LlxuICBsZXQgZmllbGRzS2V5cyA9IE9iamVjdC5rZXlzKGZpZWxkcykuc29ydCgpO1xuXG4gIC8vIElmIF9pZCBpcyB0aGUgb25seSBmaWVsZCBpbiB0aGUgcHJvamVjdGlvbiwgZG8gbm90IHJlbW92ZSBpdCwgc2luY2UgaXQgaXNcbiAgLy8gcmVxdWlyZWQgdG8gZGV0ZXJtaW5lIGlmIHRoaXMgaXMgYW4gZXhjbHVzaW9uIG9yIGV4Y2x1c2lvbi4gQWxzbyBrZWVwIGFuXG4gIC8vIGluY2x1c2l2ZSBfaWQsIHNpbmNlIGluY2x1c2l2ZSBfaWQgZm9sbG93cyB0aGUgbm9ybWFsIHJ1bGVzIGFib3V0IG1peGluZ1xuICAvLyBpbmNsdXNpdmUgYW5kIGV4Y2x1c2l2ZSBmaWVsZHMuIElmIF9pZCBpcyBub3QgdGhlIG9ubHkgZmllbGQgaW4gdGhlXG4gIC8vIHByb2plY3Rpb24gYW5kIGlzIGV4Y2x1c2l2ZSwgcmVtb3ZlIGl0IHNvIGl0IGNhbiBiZSBoYW5kbGVkIGxhdGVyIGJ5IGFcbiAgLy8gc3BlY2lhbCBjYXNlLCBzaW5jZSBleGNsdXNpdmUgX2lkIGlzIGFsd2F5cyBhbGxvd2VkLlxuICBpZiAoIShmaWVsZHNLZXlzLmxlbmd0aCA9PT0gMSAmJiBmaWVsZHNLZXlzWzBdID09PSAnX2lkJykgJiZcbiAgICAgICEoZmllbGRzS2V5cy5pbmNsdWRlcygnX2lkJykgJiYgZmllbGRzLl9pZCkpIHtcbiAgICBmaWVsZHNLZXlzID0gZmllbGRzS2V5cy5maWx0ZXIoa2V5ID0+IGtleSAhPT0gJ19pZCcpO1xuICB9XG5cbiAgbGV0IGluY2x1ZGluZyA9IG51bGw7IC8vIFVua25vd25cblxuICBmaWVsZHNLZXlzLmZvckVhY2goa2V5UGF0aCA9PiB7XG4gICAgY29uc3QgcnVsZSA9ICEhZmllbGRzW2tleVBhdGhdO1xuXG4gICAgaWYgKGluY2x1ZGluZyA9PT0gbnVsbCkge1xuICAgICAgaW5jbHVkaW5nID0gcnVsZTtcbiAgICB9XG5cbiAgICAvLyBUaGlzIGVycm9yIG1lc3NhZ2UgaXMgY29waWVkIGZyb20gTW9uZ29EQiBzaGVsbFxuICAgIGlmIChpbmNsdWRpbmcgIT09IHJ1bGUpIHtcbiAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKFxuICAgICAgICAnWW91IGNhbm5vdCBjdXJyZW50bHkgbWl4IGluY2x1ZGluZyBhbmQgZXhjbHVkaW5nIGZpZWxkcy4nXG4gICAgICApO1xuICAgIH1cbiAgfSk7XG5cbiAgY29uc3QgcHJvamVjdGlvblJ1bGVzVHJlZSA9IHBhdGhzVG9UcmVlKFxuICAgIGZpZWxkc0tleXMsXG4gICAgcGF0aCA9PiBpbmNsdWRpbmcsXG4gICAgKG5vZGUsIHBhdGgsIGZ1bGxQYXRoKSA9PiB7XG4gICAgICAvLyBDaGVjayBwYXNzZWQgcHJvamVjdGlvbiBmaWVsZHMnIGtleXM6IElmIHlvdSBoYXZlIHR3byBydWxlcyBzdWNoIGFzXG4gICAgICAvLyAnZm9vLmJhcicgYW5kICdmb28uYmFyLmJheicsIHRoZW4gdGhlIHJlc3VsdCBiZWNvbWVzIGFtYmlndW91cy4gSWZcbiAgICAgIC8vIHRoYXQgaGFwcGVucywgdGhlcmUgaXMgYSBwcm9iYWJpbGl0eSB5b3UgYXJlIGRvaW5nIHNvbWV0aGluZyB3cm9uZyxcbiAgICAgIC8vIGZyYW1ld29yayBzaG91bGQgbm90aWZ5IHlvdSBhYm91dCBzdWNoIG1pc3Rha2UgZWFybGllciBvbiBjdXJzb3JcbiAgICAgIC8vIGNvbXBpbGF0aW9uIHN0ZXAgdGhhbiBsYXRlciBkdXJpbmcgcnVudGltZS4gIE5vdGUsIHRoYXQgcmVhbCBtb25nb1xuICAgICAgLy8gZG9lc24ndCBkbyBhbnl0aGluZyBhYm91dCBpdCBhbmQgdGhlIGxhdGVyIHJ1bGUgYXBwZWFycyBpbiBwcm9qZWN0aW9uXG4gICAgICAvLyBwcm9qZWN0LCBtb3JlIHByaW9yaXR5IGl0IHRha2VzLlxuICAgICAgLy9cbiAgICAgIC8vIEV4YW1wbGUsIGFzc3VtZSBmb2xsb3dpbmcgaW4gbW9uZ28gc2hlbGw6XG4gICAgICAvLyA+IGRiLmNvbGwuaW5zZXJ0KHsgYTogeyBiOiAyMywgYzogNDQgfSB9KVxuICAgICAgLy8gPiBkYi5jb2xsLmZpbmQoe30sIHsgJ2EnOiAxLCAnYS5iJzogMSB9KVxuICAgICAgLy8ge1wiX2lkXCI6IE9iamVjdElkKFwiNTIwYmZlNDU2MDI0NjA4ZThlZjI0YWYzXCIpLCBcImFcIjoge1wiYlwiOiAyM319XG4gICAgICAvLyA+IGRiLmNvbGwuZmluZCh7fSwgeyAnYS5iJzogMSwgJ2EnOiAxIH0pXG4gICAgICAvLyB7XCJfaWRcIjogT2JqZWN0SWQoXCI1MjBiZmU0NTYwMjQ2MDhlOGVmMjRhZjNcIiksIFwiYVwiOiB7XCJiXCI6IDIzLCBcImNcIjogNDR9fVxuICAgICAgLy9cbiAgICAgIC8vIE5vdGUsIGhvdyBzZWNvbmQgdGltZSB0aGUgcmV0dXJuIHNldCBvZiBrZXlzIGlzIGRpZmZlcmVudC5cbiAgICAgIGNvbnN0IGN1cnJlbnRQYXRoID0gZnVsbFBhdGg7XG4gICAgICBjb25zdCBhbm90aGVyUGF0aCA9IHBhdGg7XG4gICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcihcbiAgICAgICAgYGJvdGggJHtjdXJyZW50UGF0aH0gYW5kICR7YW5vdGhlclBhdGh9IGZvdW5kIGluIGZpZWxkcyBvcHRpb24sIGAgK1xuICAgICAgICAndXNpbmcgYm90aCBvZiB0aGVtIG1heSB0cmlnZ2VyIHVuZXhwZWN0ZWQgYmVoYXZpb3IuIERpZCB5b3UgbWVhbiB0byAnICtcbiAgICAgICAgJ3VzZSBvbmx5IG9uZSBvZiB0aGVtPydcbiAgICAgICk7XG4gICAgfSk7XG5cbiAgcmV0dXJuIHtpbmNsdWRpbmcsIHRyZWU6IHByb2plY3Rpb25SdWxlc1RyZWV9O1xufVxuXG4vLyBUYWtlcyBhIFJlZ0V4cCBvYmplY3QgYW5kIHJldHVybnMgYW4gZWxlbWVudCBtYXRjaGVyLlxuZXhwb3J0IGZ1bmN0aW9uIHJlZ2V4cEVsZW1lbnRNYXRjaGVyKHJlZ2V4cCkge1xuICByZXR1cm4gdmFsdWUgPT4ge1xuICAgIGlmICh2YWx1ZSBpbnN0YW5jZW9mIFJlZ0V4cCkge1xuICAgICAgcmV0dXJuIHZhbHVlLnRvU3RyaW5nKCkgPT09IHJlZ2V4cC50b1N0cmluZygpO1xuICAgIH1cblxuICAgIC8vIFJlZ2V4cHMgb25seSB3b3JrIGFnYWluc3Qgc3RyaW5ncy5cbiAgICBpZiAodHlwZW9mIHZhbHVlICE9PSAnc3RyaW5nJykge1xuICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIC8vIFJlc2V0IHJlZ2V4cCdzIHN0YXRlIHRvIGF2b2lkIGluY29uc2lzdGVudCBtYXRjaGluZyBmb3Igb2JqZWN0cyB3aXRoIHRoZVxuICAgIC8vIHNhbWUgdmFsdWUgb24gY29uc2VjdXRpdmUgY2FsbHMgb2YgcmVnZXhwLnRlc3QuIFRoaXMgaGFwcGVucyBvbmx5IGlmIHRoZVxuICAgIC8vIHJlZ2V4cCBoYXMgdGhlICdnJyBmbGFnLiBBbHNvIG5vdGUgdGhhdCBFUzYgaW50cm9kdWNlcyBhIG5ldyBmbGFnICd5JyBmb3JcbiAgICAvLyB3aGljaCB3ZSBzaG91bGQgKm5vdCogY2hhbmdlIHRoZSBsYXN0SW5kZXggYnV0IE1vbmdvREIgZG9lc24ndCBzdXBwb3J0XG4gICAgLy8gZWl0aGVyIG9mIHRoZXNlIGZsYWdzLlxuICAgIHJlZ2V4cC5sYXN0SW5kZXggPSAwO1xuXG4gICAgcmV0dXJuIHJlZ2V4cC50ZXN0KHZhbHVlKTtcbiAgfTtcbn1cblxuLy8gVmFsaWRhdGVzIHRoZSBrZXkgaW4gYSBwYXRoLlxuLy8gT2JqZWN0cyB0aGF0IGFyZSBuZXN0ZWQgbW9yZSB0aGVuIDEgbGV2ZWwgY2Fubm90IGhhdmUgZG90dGVkIGZpZWxkc1xuLy8gb3IgZmllbGRzIHN0YXJ0aW5nIHdpdGggJyQnXG5mdW5jdGlvbiB2YWxpZGF0ZUtleUluUGF0aChrZXksIHBhdGgpIHtcbiAgaWYgKGtleS5pbmNsdWRlcygnLicpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYFRoZSBkb3R0ZWQgZmllbGQgJyR7a2V5fScgaW4gJyR7cGF0aH0uJHtrZXl9IGlzIG5vdCB2YWxpZCBmb3Igc3RvcmFnZS5gXG4gICAgKTtcbiAgfVxuXG4gIGlmIChrZXlbMF0gPT09ICckJykge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBUaGUgZG9sbGFyICgkKSBwcmVmaXhlZCBmaWVsZCAgJyR7cGF0aH0uJHtrZXl9IGlzIG5vdCB2YWxpZCBmb3Igc3RvcmFnZS5gXG4gICAgKTtcbiAgfVxufVxuXG4vLyBSZWN1cnNpdmVseSB2YWxpZGF0ZXMgYW4gb2JqZWN0IHRoYXQgaXMgbmVzdGVkIG1vcmUgdGhhbiBvbmUgbGV2ZWwgZGVlcFxuZnVuY3Rpb24gdmFsaWRhdGVPYmplY3Qob2JqZWN0LCBwYXRoKSB7XG4gIGlmIChvYmplY3QgJiYgT2JqZWN0LmdldFByb3RvdHlwZU9mKG9iamVjdCkgPT09IE9iamVjdC5wcm90b3R5cGUpIHtcbiAgICBPYmplY3Qua2V5cyhvYmplY3QpLmZvckVhY2goa2V5ID0+IHtcbiAgICAgIHZhbGlkYXRlS2V5SW5QYXRoKGtleSwgcGF0aCk7XG4gICAgICB2YWxpZGF0ZU9iamVjdChvYmplY3Rba2V5XSwgcGF0aCArICcuJyArIGtleSk7XG4gICAgfSk7XG4gIH1cbn1cbiIsIi8qKiBFeHBvcnRlZCB2YWx1ZXMgYXJlIGFsc28gdXNlZCBpbiB0aGUgbW9uZ28gcGFja2FnZS4gKi9cblxuLyoqIEBwYXJhbSB7c3RyaW5nfSBtZXRob2QgKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRBc3luY01ldGhvZE5hbWUobWV0aG9kKSB7XG4gIHJldHVybiBgJHttZXRob2QucmVwbGFjZSgnXycsICcnKX1Bc3luY2A7XG59XG5cbmV4cG9ydCBjb25zdCBBU1lOQ19DT0xMRUNUSU9OX01FVEhPRFMgPSBbXG4gICdfY3JlYXRlQ2FwcGVkQ29sbGVjdGlvbicsXG4gICdfZHJvcENvbGxlY3Rpb24nLFxuICAnX2Ryb3BJbmRleCcsXG4gICdjcmVhdGVJbmRleCcsXG4gICdmaW5kT25lJyxcbiAgJ2luc2VydCcsXG4gICdyZW1vdmUnLFxuICAndXBkYXRlJyxcbiAgJ3Vwc2VydCcsXG5dO1xuXG5leHBvcnQgY29uc3QgQVNZTkNfQ1VSU09SX01FVEhPRFMgPSBbJ2NvdW50JywgJ2ZldGNoJywgJ2ZvckVhY2gnLCAnbWFwJ107XG4iLCJpbXBvcnQgTG9jYWxDb2xsZWN0aW9uIGZyb20gJy4vbG9jYWxfY29sbGVjdGlvbi5qcyc7XG5pbXBvcnQgeyBoYXNPd24gfSBmcm9tICcuL2NvbW1vbi5qcyc7XG5pbXBvcnQgeyBBU1lOQ19DVVJTT1JfTUVUSE9EUywgZ2V0QXN5bmNNZXRob2ROYW1lIH0gZnJvbSBcIi4vY29uc3RhbnRzXCI7XG5cbi8vIEN1cnNvcjogYSBzcGVjaWZpY2F0aW9uIGZvciBhIHBhcnRpY3VsYXIgc3Vic2V0IG9mIGRvY3VtZW50cywgdy8gYSBkZWZpbmVkXG4vLyBvcmRlciwgbGltaXQsIGFuZCBvZmZzZXQuICBjcmVhdGluZyBhIEN1cnNvciB3aXRoIExvY2FsQ29sbGVjdGlvbi5maW5kKCksXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBDdXJzb3Ige1xuICAvLyBkb24ndCBjYWxsIHRoaXMgY3RvciBkaXJlY3RseS4gIHVzZSBMb2NhbENvbGxlY3Rpb24uZmluZCgpLlxuICBjb25zdHJ1Y3Rvcihjb2xsZWN0aW9uLCBzZWxlY3Rvciwgb3B0aW9ucyA9IHt9KSB7XG4gICAgdGhpcy5jb2xsZWN0aW9uID0gY29sbGVjdGlvbjtcbiAgICB0aGlzLnNvcnRlciA9IG51bGw7XG4gICAgdGhpcy5tYXRjaGVyID0gbmV3IE1pbmltb25nby5NYXRjaGVyKHNlbGVjdG9yKTtcblxuICAgIGlmIChMb2NhbENvbGxlY3Rpb24uX3NlbGVjdG9ySXNJZFBlcmhhcHNBc09iamVjdChzZWxlY3RvcikpIHtcbiAgICAgIC8vIHN0YXNoIGZvciBmYXN0IF9pZCBhbmQgeyBfaWQgfVxuICAgICAgdGhpcy5fc2VsZWN0b3JJZCA9IGhhc093bi5jYWxsKHNlbGVjdG9yLCAnX2lkJylcbiAgICAgICAgPyBzZWxlY3Rvci5faWRcbiAgICAgICAgOiBzZWxlY3RvcjtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5fc2VsZWN0b3JJZCA9IHVuZGVmaW5lZDtcblxuICAgICAgaWYgKHRoaXMubWF0Y2hlci5oYXNHZW9RdWVyeSgpIHx8IG9wdGlvbnMuc29ydCkge1xuICAgICAgICB0aGlzLnNvcnRlciA9IG5ldyBNaW5pbW9uZ28uU29ydGVyKG9wdGlvbnMuc29ydCB8fCBbXSk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgdGhpcy5za2lwID0gb3B0aW9ucy5za2lwIHx8IDA7XG4gICAgdGhpcy5saW1pdCA9IG9wdGlvbnMubGltaXQ7XG4gICAgdGhpcy5maWVsZHMgPSBvcHRpb25zLnByb2plY3Rpb24gfHwgb3B0aW9ucy5maWVsZHM7XG5cbiAgICB0aGlzLl9wcm9qZWN0aW9uRm4gPSBMb2NhbENvbGxlY3Rpb24uX2NvbXBpbGVQcm9qZWN0aW9uKHRoaXMuZmllbGRzIHx8IHt9KTtcblxuICAgIHRoaXMuX3RyYW5zZm9ybSA9IExvY2FsQ29sbGVjdGlvbi53cmFwVHJhbnNmb3JtKG9wdGlvbnMudHJhbnNmb3JtKTtcblxuICAgIC8vIGJ5IGRlZmF1bHQsIHF1ZXJpZXMgcmVnaXN0ZXIgdy8gVHJhY2tlciB3aGVuIGl0IGlzIGF2YWlsYWJsZS5cbiAgICBpZiAodHlwZW9mIFRyYWNrZXIgIT09ICd1bmRlZmluZWQnKSB7XG4gICAgICB0aGlzLnJlYWN0aXZlID0gb3B0aW9ucy5yZWFjdGl2ZSA9PT0gdW5kZWZpbmVkID8gdHJ1ZSA6IG9wdGlvbnMucmVhY3RpdmU7XG4gICAgfVxuICB9XG5cbiAgLyoqXG4gICAqIEBzdW1tYXJ5IFJldHVybnMgdGhlIG51bWJlciBvZiBkb2N1bWVudHMgdGhhdCBtYXRjaCBhIHF1ZXJ5LlxuICAgKiBAbWVtYmVyT2YgTW9uZ28uQ3Vyc29yXG4gICAqIEBtZXRob2QgIGNvdW50XG4gICAqIEBpbnN0YW5jZVxuICAgKiBAbG9jdXMgQW55d2hlcmVcbiAgICogQHJldHVybnMge051bWJlcn1cbiAgICovXG4gIGNvdW50KCkge1xuICAgIGlmICh0aGlzLnJlYWN0aXZlKSB7XG4gICAgICAvLyBhbGxvdyB0aGUgb2JzZXJ2ZSB0byBiZSB1bm9yZGVyZWRcbiAgICAgIHRoaXMuX2RlcGVuZCh7YWRkZWQ6IHRydWUsIHJlbW92ZWQ6IHRydWV9LCB0cnVlKTtcbiAgICB9XG5cbiAgICByZXR1cm4gdGhpcy5fZ2V0UmF3T2JqZWN0cyh7XG4gICAgICBvcmRlcmVkOiB0cnVlLFxuICAgIH0pLmxlbmd0aDtcbiAgfVxuXG4gIC8qKlxuICAgKiBAc3VtbWFyeSBSZXR1cm4gYWxsIG1hdGNoaW5nIGRvY3VtZW50cyBhcyBhbiBBcnJheS5cbiAgICogQG1lbWJlck9mIE1vbmdvLkN1cnNvclxuICAgKiBAbWV0aG9kICBmZXRjaFxuICAgKiBAaW5zdGFuY2VcbiAgICogQGxvY3VzIEFueXdoZXJlXG4gICAqIEByZXR1cm5zIHtPYmplY3RbXX1cbiAgICovXG4gIGZldGNoKCkge1xuICAgIGNvbnN0IHJlc3VsdCA9IFtdO1xuXG4gICAgdGhpcy5mb3JFYWNoKGRvYyA9PiB7XG4gICAgICByZXN1bHQucHVzaChkb2MpO1xuICAgIH0pO1xuXG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuXG4gIFtTeW1ib2wuaXRlcmF0b3JdKCkge1xuICAgIGlmICh0aGlzLnJlYWN0aXZlKSB7XG4gICAgICB0aGlzLl9kZXBlbmQoe1xuICAgICAgICBhZGRlZEJlZm9yZTogdHJ1ZSxcbiAgICAgICAgcmVtb3ZlZDogdHJ1ZSxcbiAgICAgICAgY2hhbmdlZDogdHJ1ZSxcbiAgICAgICAgbW92ZWRCZWZvcmU6IHRydWV9KTtcbiAgICB9XG5cbiAgICBsZXQgaW5kZXggPSAwO1xuICAgIGNvbnN0IG9iamVjdHMgPSB0aGlzLl9nZXRSYXdPYmplY3RzKHtvcmRlcmVkOiB0cnVlfSk7XG5cbiAgICByZXR1cm4ge1xuICAgICAgbmV4dDogKCkgPT4ge1xuICAgICAgICBpZiAoaW5kZXggPCBvYmplY3RzLmxlbmd0aCkge1xuICAgICAgICAgIC8vIFRoaXMgZG91YmxlcyBhcyBhIGNsb25lIG9wZXJhdGlvbi5cbiAgICAgICAgICBsZXQgZWxlbWVudCA9IHRoaXMuX3Byb2plY3Rpb25GbihvYmplY3RzW2luZGV4KytdKTtcblxuICAgICAgICAgIGlmICh0aGlzLl90cmFuc2Zvcm0pXG4gICAgICAgICAgICBlbGVtZW50ID0gdGhpcy5fdHJhbnNmb3JtKGVsZW1lbnQpO1xuXG4gICAgICAgICAgcmV0dXJuIHt2YWx1ZTogZWxlbWVudH07XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4ge2RvbmU6IHRydWV9O1xuICAgICAgfVxuICAgIH07XG4gIH1cblxuICBbU3ltYm9sLmFzeW5jSXRlcmF0b3JdKCkge1xuICAgIGNvbnN0IHN5bmNSZXN1bHQgPSB0aGlzW1N5bWJvbC5pdGVyYXRvcl0oKTtcbiAgICByZXR1cm4ge1xuICAgICAgYXN5bmMgbmV4dCgpIHtcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZShzeW5jUmVzdWx0Lm5leHQoKSk7XG4gICAgICB9XG4gICAgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBAY2FsbGJhY2sgSXRlcmF0aW9uQ2FsbGJhY2tcbiAgICogQHBhcmFtIHtPYmplY3R9IGRvY1xuICAgKiBAcGFyYW0ge051bWJlcn0gaW5kZXhcbiAgICovXG4gIC8qKlxuICAgKiBAc3VtbWFyeSBDYWxsIGBjYWxsYmFja2Agb25jZSBmb3IgZWFjaCBtYXRjaGluZyBkb2N1bWVudCwgc2VxdWVudGlhbGx5IGFuZFxuICAgKiAgICAgICAgICBzeW5jaHJvbm91c2x5LlxuICAgKiBAbG9jdXMgQW55d2hlcmVcbiAgICogQG1ldGhvZCAgZm9yRWFjaFxuICAgKiBAaW5zdGFuY2VcbiAgICogQG1lbWJlck9mIE1vbmdvLkN1cnNvclxuICAgKiBAcGFyYW0ge0l0ZXJhdGlvbkNhbGxiYWNrfSBjYWxsYmFjayBGdW5jdGlvbiB0byBjYWxsLiBJdCB3aWxsIGJlIGNhbGxlZFxuICAgKiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aXRoIHRocmVlIGFyZ3VtZW50czogdGhlIGRvY3VtZW50LCBhXG4gICAqICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIDAtYmFzZWQgaW5kZXgsIGFuZCA8ZW0+Y3Vyc29yPC9lbT5cbiAgICogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaXRzZWxmLlxuICAgKiBAcGFyYW0ge0FueX0gW3RoaXNBcmddIEFuIG9iamVjdCB3aGljaCB3aWxsIGJlIHRoZSB2YWx1ZSBvZiBgdGhpc2AgaW5zaWRlXG4gICAqICAgICAgICAgICAgICAgICAgICAgICAgYGNhbGxiYWNrYC5cbiAgICovXG4gIGZvckVhY2goY2FsbGJhY2ssIHRoaXNBcmcpIHtcbiAgICBpZiAodGhpcy5yZWFjdGl2ZSkge1xuICAgICAgdGhpcy5fZGVwZW5kKHtcbiAgICAgICAgYWRkZWRCZWZvcmU6IHRydWUsXG4gICAgICAgIHJlbW92ZWQ6IHRydWUsXG4gICAgICAgIGNoYW5nZWQ6IHRydWUsXG4gICAgICAgIG1vdmVkQmVmb3JlOiB0cnVlfSk7XG4gICAgfVxuXG4gICAgdGhpcy5fZ2V0UmF3T2JqZWN0cyh7b3JkZXJlZDogdHJ1ZX0pLmZvckVhY2goKGVsZW1lbnQsIGkpID0+IHtcbiAgICAgIC8vIFRoaXMgZG91YmxlcyBhcyBhIGNsb25lIG9wZXJhdGlvbi5cbiAgICAgIGVsZW1lbnQgPSB0aGlzLl9wcm9qZWN0aW9uRm4oZWxlbWVudCk7XG5cbiAgICAgIGlmICh0aGlzLl90cmFuc2Zvcm0pIHtcbiAgICAgICAgZWxlbWVudCA9IHRoaXMuX3RyYW5zZm9ybShlbGVtZW50KTtcbiAgICAgIH1cblxuICAgICAgY2FsbGJhY2suY2FsbCh0aGlzQXJnLCBlbGVtZW50LCBpLCB0aGlzKTtcbiAgICB9KTtcbiAgfVxuXG4gIGdldFRyYW5zZm9ybSgpIHtcbiAgICByZXR1cm4gdGhpcy5fdHJhbnNmb3JtO1xuICB9XG5cbiAgLyoqXG4gICAqIEBzdW1tYXJ5IE1hcCBjYWxsYmFjayBvdmVyIGFsbCBtYXRjaGluZyBkb2N1bWVudHMuICBSZXR1cm5zIGFuIEFycmF5LlxuICAgKiBAbG9jdXMgQW55d2hlcmVcbiAgICogQG1ldGhvZCBtYXBcbiAgICogQGluc3RhbmNlXG4gICAqIEBtZW1iZXJPZiBNb25nby5DdXJzb3JcbiAgICogQHBhcmFtIHtJdGVyYXRpb25DYWxsYmFja30gY2FsbGJhY2sgRnVuY3Rpb24gdG8gY2FsbC4gSXQgd2lsbCBiZSBjYWxsZWRcbiAgICogICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgd2l0aCB0aHJlZSBhcmd1bWVudHM6IHRoZSBkb2N1bWVudCwgYVxuICAgKiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAwLWJhc2VkIGluZGV4LCBhbmQgPGVtPmN1cnNvcjwvZW0+XG4gICAqICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGl0c2VsZi5cbiAgICogQHBhcmFtIHtBbnl9IFt0aGlzQXJnXSBBbiBvYmplY3Qgd2hpY2ggd2lsbCBiZSB0aGUgdmFsdWUgb2YgYHRoaXNgIGluc2lkZVxuICAgKiAgICAgICAgICAgICAgICAgICAgICAgIGBjYWxsYmFja2AuXG4gICAqL1xuICBtYXAoY2FsbGJhY2ssIHRoaXNBcmcpIHtcbiAgICBjb25zdCByZXN1bHQgPSBbXTtcblxuICAgIHRoaXMuZm9yRWFjaCgoZG9jLCBpKSA9PiB7XG4gICAgICByZXN1bHQucHVzaChjYWxsYmFjay5jYWxsKHRoaXNBcmcsIGRvYywgaSwgdGhpcykpO1xuICAgIH0pO1xuXG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuXG4gIC8vIG9wdGlvbnMgdG8gY29udGFpbjpcbiAgLy8gICogY2FsbGJhY2tzIGZvciBvYnNlcnZlKCk6XG4gIC8vICAgIC0gYWRkZWRBdCAoZG9jdW1lbnQsIGF0SW5kZXgpXG4gIC8vICAgIC0gYWRkZWQgKGRvY3VtZW50KVxuICAvLyAgICAtIGNoYW5nZWRBdCAobmV3RG9jdW1lbnQsIG9sZERvY3VtZW50LCBhdEluZGV4KVxuICAvLyAgICAtIGNoYW5nZWQgKG5ld0RvY3VtZW50LCBvbGREb2N1bWVudClcbiAgLy8gICAgLSByZW1vdmVkQXQgKGRvY3VtZW50LCBhdEluZGV4KVxuICAvLyAgICAtIHJlbW92ZWQgKGRvY3VtZW50KVxuICAvLyAgICAtIG1vdmVkVG8gKGRvY3VtZW50LCBvbGRJbmRleCwgbmV3SW5kZXgpXG4gIC8vXG4gIC8vIGF0dHJpYnV0ZXMgYXZhaWxhYmxlIG9uIHJldHVybmVkIHF1ZXJ5IGhhbmRsZTpcbiAgLy8gICogc3RvcCgpOiBlbmQgdXBkYXRlc1xuICAvLyAgKiBjb2xsZWN0aW9uOiB0aGUgY29sbGVjdGlvbiB0aGlzIHF1ZXJ5IGlzIHF1ZXJ5aW5nXG4gIC8vXG4gIC8vIGlmZiB4IGlzIGEgcmV0dXJuZWQgcXVlcnkgaGFuZGxlLCAoeCBpbnN0YW5jZW9mXG4gIC8vIExvY2FsQ29sbGVjdGlvbi5PYnNlcnZlSGFuZGxlKSBpcyB0cnVlXG4gIC8vXG4gIC8vIGluaXRpYWwgcmVzdWx0cyBkZWxpdmVyZWQgdGhyb3VnaCBhZGRlZCBjYWxsYmFja1xuICAvLyBYWFggbWF5YmUgY2FsbGJhY2tzIHNob3VsZCB0YWtlIGEgbGlzdCBvZiBvYmplY3RzLCB0byBleHBvc2UgdHJhbnNhY3Rpb25zP1xuICAvLyBYWFggbWF5YmUgc3VwcG9ydCBmaWVsZCBsaW1pdGluZyAodG8gbGltaXQgd2hhdCB5b3UncmUgbm90aWZpZWQgb24pXG5cbiAgLyoqXG4gICAqIEBzdW1tYXJ5IFdhdGNoIGEgcXVlcnkuICBSZWNlaXZlIGNhbGxiYWNrcyBhcyB0aGUgcmVzdWx0IHNldCBjaGFuZ2VzLlxuICAgKiBAbG9jdXMgQW55d2hlcmVcbiAgICogQG1lbWJlck9mIE1vbmdvLkN1cnNvclxuICAgKiBAaW5zdGFuY2VcbiAgICogQHBhcmFtIHtPYmplY3R9IGNhbGxiYWNrcyBGdW5jdGlvbnMgdG8gY2FsbCB0byBkZWxpdmVyIHRoZSByZXN1bHQgc2V0IGFzIGl0XG4gICAqICAgICAgICAgICAgICAgICAgICAgICAgICAgY2hhbmdlc1xuICAgKi9cbiAgb2JzZXJ2ZShvcHRpb25zKSB7XG4gICAgcmV0dXJuIExvY2FsQ29sbGVjdGlvbi5fb2JzZXJ2ZUZyb21PYnNlcnZlQ2hhbmdlcyh0aGlzLCBvcHRpb25zKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBAc3VtbWFyeSBXYXRjaCBhIHF1ZXJ5LiBSZWNlaXZlIGNhbGxiYWNrcyBhcyB0aGUgcmVzdWx0IHNldCBjaGFuZ2VzLiBPbmx5XG4gICAqICAgICAgICAgIHRoZSBkaWZmZXJlbmNlcyBiZXR3ZWVuIHRoZSBvbGQgYW5kIG5ldyBkb2N1bWVudHMgYXJlIHBhc3NlZCB0b1xuICAgKiAgICAgICAgICB0aGUgY2FsbGJhY2tzLlxuICAgKiBAbG9jdXMgQW55d2hlcmVcbiAgICogQG1lbWJlck9mIE1vbmdvLkN1cnNvclxuICAgKiBAaW5zdGFuY2VcbiAgICogQHBhcmFtIHtPYmplY3R9IGNhbGxiYWNrcyBGdW5jdGlvbnMgdG8gY2FsbCB0byBkZWxpdmVyIHRoZSByZXN1bHQgc2V0IGFzIGl0XG4gICAqICAgICAgICAgICAgICAgICAgICAgICAgICAgY2hhbmdlc1xuICAgKi9cbiAgb2JzZXJ2ZUNoYW5nZXMob3B0aW9ucykge1xuICAgIGNvbnN0IG9yZGVyZWQgPSBMb2NhbENvbGxlY3Rpb24uX29ic2VydmVDaGFuZ2VzQ2FsbGJhY2tzQXJlT3JkZXJlZChvcHRpb25zKTtcblxuICAgIC8vIHRoZXJlIGFyZSBzZXZlcmFsIHBsYWNlcyB0aGF0IGFzc3VtZSB5b3UgYXJlbid0IGNvbWJpbmluZyBza2lwL2xpbWl0IHdpdGhcbiAgICAvLyB1bm9yZGVyZWQgb2JzZXJ2ZS4gIGVnLCB1cGRhdGUncyBFSlNPTi5jbG9uZSwgYW5kIHRoZSBcInRoZXJlIGFyZSBzZXZlcmFsXCJcbiAgICAvLyBjb21tZW50IGluIF9tb2RpZnlBbmROb3RpZnlcbiAgICAvLyBYWFggYWxsb3cgc2tpcC9saW1pdCB3aXRoIHVub3JkZXJlZCBvYnNlcnZlXG4gICAgaWYgKCFvcHRpb25zLl9hbGxvd191bm9yZGVyZWQgJiYgIW9yZGVyZWQgJiYgKHRoaXMuc2tpcCB8fCB0aGlzLmxpbWl0KSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBcIk11c3QgdXNlIGFuIG9yZGVyZWQgb2JzZXJ2ZSB3aXRoIHNraXAgb3IgbGltaXQgKGkuZS4gJ2FkZGVkQmVmb3JlJyBcIiArXG4gICAgICAgIFwiZm9yIG9ic2VydmVDaGFuZ2VzIG9yICdhZGRlZEF0JyBmb3Igb2JzZXJ2ZSwgaW5zdGVhZCBvZiAnYWRkZWQnKS5cIlxuICAgICAgKTtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5maWVsZHMgJiYgKHRoaXMuZmllbGRzLl9pZCA9PT0gMCB8fCB0aGlzLmZpZWxkcy5faWQgPT09IGZhbHNlKSkge1xuICAgICAgdGhyb3cgRXJyb3IoJ1lvdSBtYXkgbm90IG9ic2VydmUgYSBjdXJzb3Igd2l0aCB7ZmllbGRzOiB7X2lkOiAwfX0nKTtcbiAgICB9XG5cbiAgICBjb25zdCBkaXN0YW5jZXMgPSAoXG4gICAgICB0aGlzLm1hdGNoZXIuaGFzR2VvUXVlcnkoKSAmJlxuICAgICAgb3JkZXJlZCAmJlxuICAgICAgbmV3IExvY2FsQ29sbGVjdGlvbi5fSWRNYXBcbiAgICApO1xuXG4gICAgY29uc3QgcXVlcnkgPSB7XG4gICAgICBjdXJzb3I6IHRoaXMsXG4gICAgICBkaXJ0eTogZmFsc2UsXG4gICAgICBkaXN0YW5jZXMsXG4gICAgICBtYXRjaGVyOiB0aGlzLm1hdGNoZXIsIC8vIG5vdCBmYXN0IHBhdGhlZFxuICAgICAgb3JkZXJlZCxcbiAgICAgIHByb2plY3Rpb25GbjogdGhpcy5fcHJvamVjdGlvbkZuLFxuICAgICAgcmVzdWx0c1NuYXBzaG90OiBudWxsLFxuICAgICAgc29ydGVyOiBvcmRlcmVkICYmIHRoaXMuc29ydGVyXG4gICAgfTtcblxuICAgIGxldCBxaWQ7XG5cbiAgICAvLyBOb24tcmVhY3RpdmUgcXVlcmllcyBjYWxsIGFkZGVkW0JlZm9yZV0gYW5kIHRoZW4gbmV2ZXIgY2FsbCBhbnl0aGluZ1xuICAgIC8vIGVsc2UuXG4gICAgaWYgKHRoaXMucmVhY3RpdmUpIHtcbiAgICAgIHFpZCA9IHRoaXMuY29sbGVjdGlvbi5uZXh0X3FpZCsrO1xuICAgICAgdGhpcy5jb2xsZWN0aW9uLnF1ZXJpZXNbcWlkXSA9IHF1ZXJ5O1xuICAgIH1cblxuICAgIHF1ZXJ5LnJlc3VsdHMgPSB0aGlzLl9nZXRSYXdPYmplY3RzKHtvcmRlcmVkLCBkaXN0YW5jZXM6IHF1ZXJ5LmRpc3RhbmNlc30pO1xuXG4gICAgaWYgKHRoaXMuY29sbGVjdGlvbi5wYXVzZWQpIHtcbiAgICAgIHF1ZXJ5LnJlc3VsdHNTbmFwc2hvdCA9IG9yZGVyZWQgPyBbXSA6IG5ldyBMb2NhbENvbGxlY3Rpb24uX0lkTWFwO1xuICAgIH1cblxuICAgIC8vIHdyYXAgY2FsbGJhY2tzIHdlIHdlcmUgcGFzc2VkLiBjYWxsYmFja3Mgb25seSBmaXJlIHdoZW4gbm90IHBhdXNlZCBhbmRcbiAgICAvLyBhcmUgbmV2ZXIgdW5kZWZpbmVkXG4gICAgLy8gRmlsdGVycyBvdXQgYmxhY2tsaXN0ZWQgZmllbGRzIGFjY29yZGluZyB0byBjdXJzb3IncyBwcm9qZWN0aW9uLlxuICAgIC8vIFhYWCB3cm9uZyBwbGFjZSBmb3IgdGhpcz9cblxuICAgIC8vIGZ1cnRoZXJtb3JlLCBjYWxsYmFja3MgZW5xdWV1ZSB1bnRpbCB0aGUgb3BlcmF0aW9uIHdlJ3JlIHdvcmtpbmcgb24gaXNcbiAgICAvLyBkb25lLlxuICAgIGNvbnN0IHdyYXBDYWxsYmFjayA9IGZuID0+IHtcbiAgICAgIGlmICghZm4pIHtcbiAgICAgICAgcmV0dXJuICgpID0+IHt9O1xuICAgICAgfVxuXG4gICAgICBjb25zdCBzZWxmID0gdGhpcztcbiAgICAgIHJldHVybiBmdW5jdGlvbigvKiBhcmdzKi8pIHtcbiAgICAgICAgaWYgKHNlbGYuY29sbGVjdGlvbi5wYXVzZWQpIHtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBhcmdzID0gYXJndW1lbnRzO1xuXG4gICAgICAgIHNlbGYuY29sbGVjdGlvbi5fb2JzZXJ2ZVF1ZXVlLnF1ZXVlVGFzaygoKSA9PiB7XG4gICAgICAgICAgZm4uYXBwbHkodGhpcywgYXJncyk7XG4gICAgICAgIH0pO1xuICAgICAgfTtcbiAgICB9O1xuXG4gICAgcXVlcnkuYWRkZWQgPSB3cmFwQ2FsbGJhY2sob3B0aW9ucy5hZGRlZCk7XG4gICAgcXVlcnkuY2hhbmdlZCA9IHdyYXBDYWxsYmFjayhvcHRpb25zLmNoYW5nZWQpO1xuICAgIHF1ZXJ5LnJlbW92ZWQgPSB3cmFwQ2FsbGJhY2sob3B0aW9ucy5yZW1vdmVkKTtcblxuICAgIGlmIChvcmRlcmVkKSB7XG4gICAgICBxdWVyeS5hZGRlZEJlZm9yZSA9IHdyYXBDYWxsYmFjayhvcHRpb25zLmFkZGVkQmVmb3JlKTtcbiAgICAgIHF1ZXJ5Lm1vdmVkQmVmb3JlID0gd3JhcENhbGxiYWNrKG9wdGlvbnMubW92ZWRCZWZvcmUpO1xuICAgIH1cblxuICAgIGlmICghb3B0aW9ucy5fc3VwcHJlc3NfaW5pdGlhbCAmJiAhdGhpcy5jb2xsZWN0aW9uLnBhdXNlZCkge1xuICAgICAgcXVlcnkucmVzdWx0cy5mb3JFYWNoKGRvYyA9PiB7XG4gICAgICAgIGNvbnN0IGZpZWxkcyA9IEVKU09OLmNsb25lKGRvYyk7XG5cbiAgICAgICAgZGVsZXRlIGZpZWxkcy5faWQ7XG5cbiAgICAgICAgaWYgKG9yZGVyZWQpIHtcbiAgICAgICAgICBxdWVyeS5hZGRlZEJlZm9yZShkb2MuX2lkLCB0aGlzLl9wcm9qZWN0aW9uRm4oZmllbGRzKSwgbnVsbCk7XG4gICAgICAgIH1cblxuICAgICAgICBxdWVyeS5hZGRlZChkb2MuX2lkLCB0aGlzLl9wcm9qZWN0aW9uRm4oZmllbGRzKSk7XG4gICAgICB9KTtcbiAgICB9XG5cbiAgICBjb25zdCBoYW5kbGUgPSBPYmplY3QuYXNzaWduKG5ldyBMb2NhbENvbGxlY3Rpb24uT2JzZXJ2ZUhhbmRsZSwge1xuICAgICAgY29sbGVjdGlvbjogdGhpcy5jb2xsZWN0aW9uLFxuICAgICAgc3RvcDogKCkgPT4ge1xuICAgICAgICBpZiAodGhpcy5yZWFjdGl2ZSkge1xuICAgICAgICAgIGRlbGV0ZSB0aGlzLmNvbGxlY3Rpb24ucXVlcmllc1txaWRdO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBpZiAodGhpcy5yZWFjdGl2ZSAmJiBUcmFja2VyLmFjdGl2ZSkge1xuICAgICAgLy8gWFhYIGluIG1hbnkgY2FzZXMsIHRoZSBzYW1lIG9ic2VydmUgd2lsbCBiZSByZWNyZWF0ZWQgd2hlblxuICAgICAgLy8gdGhlIGN1cnJlbnQgYXV0b3J1biBpcyByZXJ1bi4gIHdlIGNvdWxkIHNhdmUgd29yayBieVxuICAgICAgLy8gbGV0dGluZyBpdCBsaW5nZXIgYWNyb3NzIHJlcnVuIGFuZCBwb3RlbnRpYWxseSBnZXRcbiAgICAgIC8vIHJlcHVycG9zZWQgaWYgdGhlIHNhbWUgb2JzZXJ2ZSBpcyBwZXJmb3JtZWQsIHVzaW5nIGxvZ2ljXG4gICAgICAvLyBzaW1pbGFyIHRvIHRoYXQgb2YgTWV0ZW9yLnN1YnNjcmliZS5cbiAgICAgIFRyYWNrZXIub25JbnZhbGlkYXRlKCgpID0+IHtcbiAgICAgICAgaGFuZGxlLnN0b3AoKTtcbiAgICAgIH0pO1xuICAgIH1cblxuICAgIC8vIHJ1biB0aGUgb2JzZXJ2ZSBjYWxsYmFja3MgcmVzdWx0aW5nIGZyb20gdGhlIGluaXRpYWwgY29udGVudHNcbiAgICAvLyBiZWZvcmUgd2UgbGVhdmUgdGhlIG9ic2VydmUuXG4gICAgdGhpcy5jb2xsZWN0aW9uLl9vYnNlcnZlUXVldWUuZHJhaW4oKTtcblxuICAgIHJldHVybiBoYW5kbGU7XG4gIH1cblxuICAvLyBYWFggTWF5YmUgd2UgbmVlZCBhIHZlcnNpb24gb2Ygb2JzZXJ2ZSB0aGF0IGp1c3QgY2FsbHMgYSBjYWxsYmFjayBpZlxuICAvLyBhbnl0aGluZyBjaGFuZ2VkLlxuICBfZGVwZW5kKGNoYW5nZXJzLCBfYWxsb3dfdW5vcmRlcmVkKSB7XG4gICAgaWYgKFRyYWNrZXIuYWN0aXZlKSB7XG4gICAgICBjb25zdCBkZXBlbmRlbmN5ID0gbmV3IFRyYWNrZXIuRGVwZW5kZW5jeTtcbiAgICAgIGNvbnN0IG5vdGlmeSA9IGRlcGVuZGVuY3kuY2hhbmdlZC5iaW5kKGRlcGVuZGVuY3kpO1xuXG4gICAgICBkZXBlbmRlbmN5LmRlcGVuZCgpO1xuXG4gICAgICBjb25zdCBvcHRpb25zID0ge19hbGxvd191bm9yZGVyZWQsIF9zdXBwcmVzc19pbml0aWFsOiB0cnVlfTtcblxuICAgICAgWydhZGRlZCcsICdhZGRlZEJlZm9yZScsICdjaGFuZ2VkJywgJ21vdmVkQmVmb3JlJywgJ3JlbW92ZWQnXVxuICAgICAgICAuZm9yRWFjaChmbiA9PiB7XG4gICAgICAgICAgaWYgKGNoYW5nZXJzW2ZuXSkge1xuICAgICAgICAgICAgb3B0aW9uc1tmbl0gPSBub3RpZnk7XG4gICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgLy8gb2JzZXJ2ZUNoYW5nZXMgd2lsbCBzdG9wKCkgd2hlbiB0aGlzIGNvbXB1dGF0aW9uIGlzIGludmFsaWRhdGVkXG4gICAgICB0aGlzLm9ic2VydmVDaGFuZ2VzKG9wdGlvbnMpO1xuICAgIH1cbiAgfVxuXG4gIF9nZXRDb2xsZWN0aW9uTmFtZSgpIHtcbiAgICByZXR1cm4gdGhpcy5jb2xsZWN0aW9uLm5hbWU7XG4gIH1cblxuICAvLyBSZXR1cm5zIGEgY29sbGVjdGlvbiBvZiBtYXRjaGluZyBvYmplY3RzLCBidXQgZG9lc24ndCBkZWVwIGNvcHkgdGhlbS5cbiAgLy9cbiAgLy8gSWYgb3JkZXJlZCBpcyBzZXQsIHJldHVybnMgYSBzb3J0ZWQgYXJyYXksIHJlc3BlY3Rpbmcgc29ydGVyLCBza2lwLCBhbmRcbiAgLy8gbGltaXQgcHJvcGVydGllcyBvZiB0aGUgcXVlcnkgcHJvdmlkZWQgdGhhdCBvcHRpb25zLmFwcGx5U2tpcExpbWl0IGlzXG4gIC8vIG5vdCBzZXQgdG8gZmFsc2UgKCMxMjAxKS4gSWYgc29ydGVyIGlzIGZhbHNleSwgbm8gc29ydCAtLSB5b3UgZ2V0IHRoZVxuICAvLyBuYXR1cmFsIG9yZGVyLlxuICAvL1xuICAvLyBJZiBvcmRlcmVkIGlzIG5vdCBzZXQsIHJldHVybnMgYW4gb2JqZWN0IG1hcHBpbmcgZnJvbSBJRCB0byBkb2MgKHNvcnRlcixcbiAgLy8gc2tpcCBhbmQgbGltaXQgc2hvdWxkIG5vdCBiZSBzZXQpLlxuICAvL1xuICAvLyBJZiBvcmRlcmVkIGlzIHNldCBhbmQgdGhpcyBjdXJzb3IgaXMgYSAkbmVhciBnZW9xdWVyeSwgdGhlbiB0aGlzIGZ1bmN0aW9uXG4gIC8vIHdpbGwgdXNlIGFuIF9JZE1hcCB0byB0cmFjayBlYWNoIGRpc3RhbmNlIGZyb20gdGhlICRuZWFyIGFyZ3VtZW50IHBvaW50IGluXG4gIC8vIG9yZGVyIHRvIHVzZSBpdCBhcyBhIHNvcnQga2V5LiBJZiBhbiBfSWRNYXAgaXMgcGFzc2VkIGluIHRoZSAnZGlzdGFuY2VzJ1xuICAvLyBhcmd1bWVudCwgdGhpcyBmdW5jdGlvbiB3aWxsIGNsZWFyIGl0IGFuZCB1c2UgaXQgZm9yIHRoaXMgcHVycG9zZVxuICAvLyAob3RoZXJ3aXNlIGl0IHdpbGwganVzdCBjcmVhdGUgaXRzIG93biBfSWRNYXApLiBUaGUgb2JzZXJ2ZUNoYW5nZXNcbiAgLy8gaW1wbGVtZW50YXRpb24gdXNlcyB0aGlzIHRvIHJlbWVtYmVyIHRoZSBkaXN0YW5jZXMgYWZ0ZXIgdGhpcyBmdW5jdGlvblxuICAvLyByZXR1cm5zLlxuICBfZ2V0UmF3T2JqZWN0cyhvcHRpb25zID0ge30pIHtcbiAgICAvLyBCeSBkZWZhdWx0IHRoaXMgbWV0aG9kIHdpbGwgcmVzcGVjdCBza2lwIGFuZCBsaW1pdCBiZWNhdXNlIC5mZXRjaCgpLFxuICAgIC8vIC5mb3JFYWNoKCkgZXRjLi4uIGV4cGVjdCB0aGlzIGJlaGF2aW91ci4gSXQgY2FuIGJlIGZvcmNlZCB0byBpZ25vcmVcbiAgICAvLyBza2lwIGFuZCBsaW1pdCBieSBzZXR0aW5nIGFwcGx5U2tpcExpbWl0IHRvIGZhbHNlICguY291bnQoKSBkb2VzIHRoaXMsXG4gICAgLy8gZm9yIGV4YW1wbGUpXG4gICAgY29uc3QgYXBwbHlTa2lwTGltaXQgPSBvcHRpb25zLmFwcGx5U2tpcExpbWl0ICE9PSBmYWxzZTtcblxuICAgIC8vIFhYWCB1c2UgT3JkZXJlZERpY3QgaW5zdGVhZCBvZiBhcnJheSwgYW5kIG1ha2UgSWRNYXAgYW5kIE9yZGVyZWREaWN0XG4gICAgLy8gY29tcGF0aWJsZVxuICAgIGNvbnN0IHJlc3VsdHMgPSBvcHRpb25zLm9yZGVyZWQgPyBbXSA6IG5ldyBMb2NhbENvbGxlY3Rpb24uX0lkTWFwO1xuXG4gICAgLy8gZmFzdCBwYXRoIGZvciBzaW5nbGUgSUQgdmFsdWVcbiAgICBpZiAodGhpcy5fc2VsZWN0b3JJZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAvLyBJZiB5b3UgaGF2ZSBub24temVybyBza2lwIGFuZCBhc2sgZm9yIGEgc2luZ2xlIGlkLCB5b3UgZ2V0IG5vdGhpbmcuXG4gICAgICAvLyBUaGlzIGlzIHNvIGl0IG1hdGNoZXMgdGhlIGJlaGF2aW9yIG9mIHRoZSAne19pZDogZm9vfScgcGF0aC5cbiAgICAgIGlmIChhcHBseVNraXBMaW1pdCAmJiB0aGlzLnNraXApIHtcbiAgICAgICAgcmV0dXJuIHJlc3VsdHM7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHNlbGVjdGVkRG9jID0gdGhpcy5jb2xsZWN0aW9uLl9kb2NzLmdldCh0aGlzLl9zZWxlY3RvcklkKTtcblxuICAgICAgaWYgKHNlbGVjdGVkRG9jKSB7XG4gICAgICAgIGlmIChvcHRpb25zLm9yZGVyZWQpIHtcbiAgICAgICAgICByZXN1bHRzLnB1c2goc2VsZWN0ZWREb2MpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHJlc3VsdHMuc2V0KHRoaXMuX3NlbGVjdG9ySWQsIHNlbGVjdGVkRG9jKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICByZXR1cm4gcmVzdWx0cztcbiAgICB9XG5cbiAgICAvLyBzbG93IHBhdGggZm9yIGFyYml0cmFyeSBzZWxlY3Rvciwgc29ydCwgc2tpcCwgbGltaXRcblxuICAgIC8vIGluIHRoZSBvYnNlcnZlQ2hhbmdlcyBjYXNlLCBkaXN0YW5jZXMgaXMgYWN0dWFsbHkgcGFydCBvZiB0aGUgXCJxdWVyeVwiXG4gICAgLy8gKGllLCBsaXZlIHJlc3VsdHMgc2V0KSBvYmplY3QuICBpbiBvdGhlciBjYXNlcywgZGlzdGFuY2VzIGlzIG9ubHkgdXNlZFxuICAgIC8vIGluc2lkZSB0aGlzIGZ1bmN0aW9uLlxuICAgIGxldCBkaXN0YW5jZXM7XG4gICAgaWYgKHRoaXMubWF0Y2hlci5oYXNHZW9RdWVyeSgpICYmIG9wdGlvbnMub3JkZXJlZCkge1xuICAgICAgaWYgKG9wdGlvbnMuZGlzdGFuY2VzKSB7XG4gICAgICAgIGRpc3RhbmNlcyA9IG9wdGlvbnMuZGlzdGFuY2VzO1xuICAgICAgICBkaXN0YW5jZXMuY2xlYXIoKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGRpc3RhbmNlcyA9IG5ldyBMb2NhbENvbGxlY3Rpb24uX0lkTWFwKCk7XG4gICAgICB9XG4gICAgfVxuXG4gICAgdGhpcy5jb2xsZWN0aW9uLl9kb2NzLmZvckVhY2goKGRvYywgaWQpID0+IHtcbiAgICAgIGNvbnN0IG1hdGNoUmVzdWx0ID0gdGhpcy5tYXRjaGVyLmRvY3VtZW50TWF0Y2hlcyhkb2MpO1xuXG4gICAgICBpZiAobWF0Y2hSZXN1bHQucmVzdWx0KSB7XG4gICAgICAgIGlmIChvcHRpb25zLm9yZGVyZWQpIHtcbiAgICAgICAgICByZXN1bHRzLnB1c2goZG9jKTtcblxuICAgICAgICAgIGlmIChkaXN0YW5jZXMgJiYgbWF0Y2hSZXN1bHQuZGlzdGFuY2UgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgZGlzdGFuY2VzLnNldChpZCwgbWF0Y2hSZXN1bHQuZGlzdGFuY2UpO1xuICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByZXN1bHRzLnNldChpZCwgZG9jKTtcbiAgICAgICAgfVxuICAgICAgfVxuXG4gICAgICAvLyBPdmVycmlkZSB0byBlbnN1cmUgYWxsIGRvY3MgYXJlIG1hdGNoZWQgaWYgaWdub3Jpbmcgc2tpcCAmIGxpbWl0XG4gICAgICBpZiAoIWFwcGx5U2tpcExpbWl0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgfVxuXG4gICAgICAvLyBGYXN0IHBhdGggZm9yIGxpbWl0ZWQgdW5zb3J0ZWQgcXVlcmllcy5cbiAgICAgIC8vIFhYWCAnbGVuZ3RoJyBjaGVjayBoZXJlIHNlZW1zIHdyb25nIGZvciBvcmRlcmVkXG4gICAgICByZXR1cm4gKFxuICAgICAgICAhdGhpcy5saW1pdCB8fFxuICAgICAgICB0aGlzLnNraXAgfHxcbiAgICAgICAgdGhpcy5zb3J0ZXIgfHxcbiAgICAgICAgcmVzdWx0cy5sZW5ndGggIT09IHRoaXMubGltaXRcbiAgICAgICk7XG4gICAgfSk7XG5cbiAgICBpZiAoIW9wdGlvbnMub3JkZXJlZCkge1xuICAgICAgcmV0dXJuIHJlc3VsdHM7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuc29ydGVyKSB7XG4gICAgICByZXN1bHRzLnNvcnQodGhpcy5zb3J0ZXIuZ2V0Q29tcGFyYXRvcih7ZGlzdGFuY2VzfSkpO1xuICAgIH1cblxuICAgIC8vIFJldHVybiB0aGUgZnVsbCBzZXQgb2YgcmVzdWx0cyBpZiB0aGVyZSBpcyBubyBza2lwIG9yIGxpbWl0IG9yIGlmIHdlJ3JlXG4gICAgLy8gaWdub3JpbmcgdGhlbVxuICAgIGlmICghYXBwbHlTa2lwTGltaXQgfHwgKCF0aGlzLmxpbWl0ICYmICF0aGlzLnNraXApKSB7XG4gICAgICByZXR1cm4gcmVzdWx0cztcbiAgICB9XG5cbiAgICByZXR1cm4gcmVzdWx0cy5zbGljZShcbiAgICAgIHRoaXMuc2tpcCxcbiAgICAgIHRoaXMubGltaXQgPyB0aGlzLmxpbWl0ICsgdGhpcy5za2lwIDogcmVzdWx0cy5sZW5ndGhcbiAgICApO1xuICB9XG5cbiAgX3B1Ymxpc2hDdXJzb3Ioc3Vic2NyaXB0aW9uKSB7XG4gICAgLy8gWFhYIG1pbmltb25nbyBzaG91bGQgbm90IGRlcGVuZCBvbiBtb25nby1saXZlZGF0YSFcbiAgICBpZiAoIVBhY2thZ2UubW9uZ28pIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgJ0NhblxcJ3QgcHVibGlzaCBmcm9tIE1pbmltb25nbyB3aXRob3V0IHRoZSBgbW9uZ29gIHBhY2thZ2UuJ1xuICAgICAgKTtcbiAgICB9XG5cbiAgICBpZiAoIXRoaXMuY29sbGVjdGlvbi5uYW1lKSB7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAgICdDYW5cXCd0IHB1Ymxpc2ggYSBjdXJzb3IgZnJvbSBhIGNvbGxlY3Rpb24gd2l0aG91dCBhIG5hbWUuJ1xuICAgICAgKTtcbiAgICB9XG5cbiAgICByZXR1cm4gUGFja2FnZS5tb25nby5Nb25nby5Db2xsZWN0aW9uLl9wdWJsaXNoQ3Vyc29yKFxuICAgICAgdGhpcyxcbiAgICAgIHN1YnNjcmlwdGlvbixcbiAgICAgIHRoaXMuY29sbGVjdGlvbi5uYW1lXG4gICAgKTtcbiAgfVxufVxuXG4vLyBJbXBsZW1lbnRzIGFzeW5jIHZlcnNpb24gb2YgY3Vyc29yIG1ldGhvZHMgdG8ga2VlcCBjb2xsZWN0aW9ucyBpc29tb3JwaGljXG5BU1lOQ19DVVJTT1JfTUVUSE9EUy5mb3JFYWNoKG1ldGhvZCA9PiB7XG4gIGNvbnN0IGFzeW5jTmFtZSA9IGdldEFzeW5jTWV0aG9kTmFtZShtZXRob2QpO1xuICBDdXJzb3IucHJvdG90eXBlW2FzeW5jTmFtZV0gPSBmdW5jdGlvbiguLi5hcmdzKSB7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh0aGlzW21ldGhvZF0uYXBwbHkodGhpcywgYXJncykpO1xuICB9O1xufSk7XG4iLCJpbXBvcnQgQ3Vyc29yIGZyb20gJy4vY3Vyc29yLmpzJztcbmltcG9ydCBPYnNlcnZlSGFuZGxlIGZyb20gJy4vb2JzZXJ2ZV9oYW5kbGUuanMnO1xuaW1wb3J0IHtcbiAgaGFzT3duLFxuICBpc0luZGV4YWJsZSxcbiAgaXNOdW1lcmljS2V5LFxuICBpc09wZXJhdG9yT2JqZWN0LFxuICBwb3B1bGF0ZURvY3VtZW50V2l0aFF1ZXJ5RmllbGRzLFxuICBwcm9qZWN0aW9uRGV0YWlscyxcbn0gZnJvbSAnLi9jb21tb24uanMnO1xuXG4vLyBYWFggdHlwZSBjaGVja2luZyBvbiBzZWxlY3RvcnMgKGdyYWNlZnVsIGVycm9yIGlmIG1hbGZvcm1lZClcblxuLy8gTG9jYWxDb2xsZWN0aW9uOiBhIHNldCBvZiBkb2N1bWVudHMgdGhhdCBzdXBwb3J0cyBxdWVyaWVzIGFuZCBtb2RpZmllcnMuXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBMb2NhbENvbGxlY3Rpb24ge1xuICBjb25zdHJ1Y3RvcihuYW1lKSB7XG4gICAgdGhpcy5uYW1lID0gbmFtZTtcbiAgICAvLyBfaWQgLT4gZG9jdW1lbnQgKGFsc28gY29udGFpbmluZyBpZClcbiAgICB0aGlzLl9kb2NzID0gbmV3IExvY2FsQ29sbGVjdGlvbi5fSWRNYXA7XG5cbiAgICB0aGlzLl9vYnNlcnZlUXVldWUgPSBuZXcgTWV0ZW9yLl9TeW5jaHJvbm91c1F1ZXVlKCk7XG5cbiAgICB0aGlzLm5leHRfcWlkID0gMTsgLy8gbGl2ZSBxdWVyeSBpZCBnZW5lcmF0b3JcblxuICAgIC8vIHFpZCAtPiBsaXZlIHF1ZXJ5IG9iamVjdC4ga2V5czpcbiAgICAvLyAgb3JkZXJlZDogYm9vbC4gb3JkZXJlZCBxdWVyaWVzIGhhdmUgYWRkZWRCZWZvcmUvbW92ZWRCZWZvcmUgY2FsbGJhY2tzLlxuICAgIC8vICByZXN1bHRzOiBhcnJheSAob3JkZXJlZCkgb3Igb2JqZWN0ICh1bm9yZGVyZWQpIG9mIGN1cnJlbnQgcmVzdWx0c1xuICAgIC8vICAgIChhbGlhc2VkIHdpdGggdGhpcy5fZG9jcyEpXG4gICAgLy8gIHJlc3VsdHNTbmFwc2hvdDogc25hcHNob3Qgb2YgcmVzdWx0cy4gbnVsbCBpZiBub3QgcGF1c2VkLlxuICAgIC8vICBjdXJzb3I6IEN1cnNvciBvYmplY3QgZm9yIHRoZSBxdWVyeS5cbiAgICAvLyAgc2VsZWN0b3IsIHNvcnRlciwgKGNhbGxiYWNrcyk6IGZ1bmN0aW9uc1xuICAgIHRoaXMucXVlcmllcyA9IE9iamVjdC5jcmVhdGUobnVsbCk7XG5cbiAgICAvLyBudWxsIGlmIG5vdCBzYXZpbmcgb3JpZ2luYWxzOyBhbiBJZE1hcCBmcm9tIGlkIHRvIG9yaWdpbmFsIGRvY3VtZW50IHZhbHVlXG4gICAgLy8gaWYgc2F2aW5nIG9yaWdpbmFscy4gU2VlIGNvbW1lbnRzIGJlZm9yZSBzYXZlT3JpZ2luYWxzKCkuXG4gICAgdGhpcy5fc2F2ZWRPcmlnaW5hbHMgPSBudWxsO1xuXG4gICAgLy8gVHJ1ZSB3aGVuIG9ic2VydmVycyBhcmUgcGF1c2VkIGFuZCB3ZSBzaG91bGQgbm90IHNlbmQgY2FsbGJhY2tzLlxuICAgIHRoaXMucGF1c2VkID0gZmFsc2U7XG4gIH1cblxuICAvLyBvcHRpb25zIG1heSBpbmNsdWRlIHNvcnQsIHNraXAsIGxpbWl0LCByZWFjdGl2ZVxuICAvLyBzb3J0IG1heSBiZSBhbnkgb2YgdGhlc2UgZm9ybXM6XG4gIC8vICAgICB7YTogMSwgYjogLTF9XG4gIC8vICAgICBbW1wiYVwiLCBcImFzY1wiXSwgW1wiYlwiLCBcImRlc2NcIl1dXG4gIC8vICAgICBbXCJhXCIsIFtcImJcIiwgXCJkZXNjXCJdXVxuICAvLyAgIChpbiB0aGUgZmlyc3QgZm9ybSB5b3UncmUgYmVob2xkZW4gdG8ga2V5IGVudW1lcmF0aW9uIG9yZGVyIGluXG4gIC8vICAgeW91ciBqYXZhc2NyaXB0IFZNKVxuICAvL1xuICAvLyByZWFjdGl2ZTogaWYgZ2l2ZW4sIGFuZCBmYWxzZSwgZG9uJ3QgcmVnaXN0ZXIgd2l0aCBUcmFja2VyIChkZWZhdWx0XG4gIC8vIGlzIHRydWUpXG4gIC8vXG4gIC8vIFhYWCBwb3NzaWJseSBzaG91bGQgc3VwcG9ydCByZXRyaWV2aW5nIGEgc3Vic2V0IG9mIGZpZWxkcz8gYW5kXG4gIC8vIGhhdmUgaXQgYmUgYSBoaW50IChpZ25vcmVkIG9uIHRoZSBjbGllbnQsIHdoZW4gbm90IGNvcHlpbmcgdGhlXG4gIC8vIGRvYz8pXG4gIC8vXG4gIC8vIFhYWCBzb3J0IGRvZXMgbm90IHlldCBzdXBwb3J0IHN1YmtleXMgKCdhLmInKSAuLiBmaXggdGhhdCFcbiAgLy8gWFhYIGFkZCBvbmUgbW9yZSBzb3J0IGZvcm06IFwia2V5XCJcbiAgLy8gWFhYIHRlc3RzXG4gIGZpbmQoc2VsZWN0b3IsIG9wdGlvbnMpIHtcbiAgICAvLyBkZWZhdWx0IHN5bnRheCBmb3IgZXZlcnl0aGluZyBpcyB0byBvbWl0IHRoZSBzZWxlY3RvciBhcmd1bWVudC5cbiAgICAvLyBidXQgaWYgc2VsZWN0b3IgaXMgZXhwbGljaXRseSBwYXNzZWQgaW4gYXMgZmFsc2Ugb3IgdW5kZWZpbmVkLCB3ZVxuICAgIC8vIHdhbnQgYSBzZWxlY3RvciB0aGF0IG1hdGNoZXMgbm90aGluZy5cbiAgICBpZiAoYXJndW1lbnRzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgc2VsZWN0b3IgPSB7fTtcbiAgICB9XG5cbiAgICByZXR1cm4gbmV3IExvY2FsQ29sbGVjdGlvbi5DdXJzb3IodGhpcywgc2VsZWN0b3IsIG9wdGlvbnMpO1xuICB9XG5cbiAgZmluZE9uZShzZWxlY3Rvciwgb3B0aW9ucyA9IHt9KSB7XG4gICAgaWYgKGFyZ3VtZW50cy5sZW5ndGggPT09IDApIHtcbiAgICAgIHNlbGVjdG9yID0ge307XG4gICAgfVxuXG4gICAgLy8gTk9URTogYnkgc2V0dGluZyBsaW1pdCAxIGhlcmUsIHdlIGVuZCB1cCB1c2luZyB2ZXJ5IGluZWZmaWNpZW50XG4gICAgLy8gY29kZSB0aGF0IHJlY29tcHV0ZXMgdGhlIHdob2xlIHF1ZXJ5IG9uIGVhY2ggdXBkYXRlLiBUaGUgdXBzaWRlIGlzXG4gICAgLy8gdGhhdCB3aGVuIHlvdSByZWFjdGl2ZWx5IGRlcGVuZCBvbiBhIGZpbmRPbmUgeW91IG9ubHkgZ2V0XG4gICAgLy8gaW52YWxpZGF0ZWQgd2hlbiB0aGUgZm91bmQgb2JqZWN0IGNoYW5nZXMsIG5vdCBhbnkgb2JqZWN0IGluIHRoZVxuICAgIC8vIGNvbGxlY3Rpb24uIE1vc3QgZmluZE9uZSB3aWxsIGJlIGJ5IGlkLCB3aGljaCBoYXMgYSBmYXN0IHBhdGgsIHNvXG4gICAgLy8gdGhpcyBtaWdodCBub3QgYmUgYSBiaWcgZGVhbC4gSW4gbW9zdCBjYXNlcywgaW52YWxpZGF0aW9uIGNhdXNlc1xuICAgIC8vIHRoZSBjYWxsZWQgdG8gcmUtcXVlcnkgYW55d2F5LCBzbyB0aGlzIHNob3VsZCBiZSBhIG5ldCBwZXJmb3JtYW5jZVxuICAgIC8vIGltcHJvdmVtZW50LlxuICAgIG9wdGlvbnMubGltaXQgPSAxO1xuXG4gICAgcmV0dXJuIHRoaXMuZmluZChzZWxlY3Rvciwgb3B0aW9ucykuZmV0Y2goKVswXTtcbiAgfVxuXG4gIC8vIFhYWCBwb3NzaWJseSBlbmZvcmNlIHRoYXQgJ3VuZGVmaW5lZCcgZG9lcyBub3QgYXBwZWFyICh3ZSBhc3N1bWVcbiAgLy8gdGhpcyBpbiBvdXIgaGFuZGxpbmcgb2YgbnVsbCBhbmQgJGV4aXN0cylcbiAgaW5zZXJ0KGRvYywgY2FsbGJhY2spIHtcbiAgICBkb2MgPSBFSlNPTi5jbG9uZShkb2MpO1xuXG4gICAgYXNzZXJ0SGFzVmFsaWRGaWVsZE5hbWVzKGRvYyk7XG5cbiAgICAvLyBpZiB5b3UgcmVhbGx5IHdhbnQgdG8gdXNlIE9iamVjdElEcywgc2V0IHRoaXMgZ2xvYmFsLlxuICAgIC8vIE1vbmdvLkNvbGxlY3Rpb24gc3BlY2lmaWVzIGl0cyBvd24gaWRzIGFuZCBkb2VzIG5vdCB1c2UgdGhpcyBjb2RlLlxuICAgIGlmICghaGFzT3duLmNhbGwoZG9jLCAnX2lkJykpIHtcbiAgICAgIGRvYy5faWQgPSBMb2NhbENvbGxlY3Rpb24uX3VzZU9JRCA/IG5ldyBNb25nb0lELk9iamVjdElEKCkgOiBSYW5kb20uaWQoKTtcbiAgICB9XG5cbiAgICBjb25zdCBpZCA9IGRvYy5faWQ7XG5cbiAgICBpZiAodGhpcy5fZG9jcy5oYXMoaWQpKSB7XG4gICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcihgRHVwbGljYXRlIF9pZCAnJHtpZH0nYCk7XG4gICAgfVxuXG4gICAgdGhpcy5fc2F2ZU9yaWdpbmFsKGlkLCB1bmRlZmluZWQpO1xuICAgIHRoaXMuX2RvY3Muc2V0KGlkLCBkb2MpO1xuXG4gICAgY29uc3QgcXVlcmllc1RvUmVjb21wdXRlID0gW107XG5cbiAgICAvLyB0cmlnZ2VyIGxpdmUgcXVlcmllcyB0aGF0IG1hdGNoXG4gICAgT2JqZWN0LmtleXModGhpcy5xdWVyaWVzKS5mb3JFYWNoKHFpZCA9PiB7XG4gICAgICBjb25zdCBxdWVyeSA9IHRoaXMucXVlcmllc1txaWRdO1xuXG4gICAgICBpZiAocXVlcnkuZGlydHkpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBtYXRjaFJlc3VsdCA9IHF1ZXJ5Lm1hdGNoZXIuZG9jdW1lbnRNYXRjaGVzKGRvYyk7XG5cbiAgICAgIGlmIChtYXRjaFJlc3VsdC5yZXN1bHQpIHtcbiAgICAgICAgaWYgKHF1ZXJ5LmRpc3RhbmNlcyAmJiBtYXRjaFJlc3VsdC5kaXN0YW5jZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgICAgcXVlcnkuZGlzdGFuY2VzLnNldChpZCwgbWF0Y2hSZXN1bHQuZGlzdGFuY2UpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHF1ZXJ5LmN1cnNvci5za2lwIHx8IHF1ZXJ5LmN1cnNvci5saW1pdCkge1xuICAgICAgICAgIHF1ZXJpZXNUb1JlY29tcHV0ZS5wdXNoKHFpZCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgTG9jYWxDb2xsZWN0aW9uLl9pbnNlcnRJblJlc3VsdHMocXVlcnksIGRvYyk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9KTtcblxuICAgIHF1ZXJpZXNUb1JlY29tcHV0ZS5mb3JFYWNoKHFpZCA9PiB7XG4gICAgICBpZiAodGhpcy5xdWVyaWVzW3FpZF0pIHtcbiAgICAgICAgdGhpcy5fcmVjb21wdXRlUmVzdWx0cyh0aGlzLnF1ZXJpZXNbcWlkXSk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICB0aGlzLl9vYnNlcnZlUXVldWUuZHJhaW4oKTtcblxuICAgIC8vIERlZmVyIGJlY2F1c2UgdGhlIGNhbGxlciBsaWtlbHkgZG9lc24ndCBleHBlY3QgdGhlIGNhbGxiYWNrIHRvIGJlIHJ1blxuICAgIC8vIGltbWVkaWF0ZWx5LlxuICAgIGlmIChjYWxsYmFjaykge1xuICAgICAgTWV0ZW9yLmRlZmVyKCgpID0+IHtcbiAgICAgICAgY2FsbGJhY2sobnVsbCwgaWQpO1xuICAgICAgfSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIGlkO1xuICB9XG5cbiAgLy8gUGF1c2UgdGhlIG9ic2VydmVycy4gTm8gY2FsbGJhY2tzIGZyb20gb2JzZXJ2ZXJzIHdpbGwgZmlyZSB1bnRpbFxuICAvLyAncmVzdW1lT2JzZXJ2ZXJzJyBpcyBjYWxsZWQuXG4gIHBhdXNlT2JzZXJ2ZXJzKCkge1xuICAgIC8vIE5vLW9wIGlmIGFscmVhZHkgcGF1c2VkLlxuICAgIGlmICh0aGlzLnBhdXNlZCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIFNldCB0aGUgJ3BhdXNlZCcgZmxhZyBzdWNoIHRoYXQgbmV3IG9ic2VydmVyIG1lc3NhZ2VzIGRvbid0IGZpcmUuXG4gICAgdGhpcy5wYXVzZWQgPSB0cnVlO1xuXG4gICAgLy8gVGFrZSBhIHNuYXBzaG90IG9mIHRoZSBxdWVyeSByZXN1bHRzIGZvciBlYWNoIHF1ZXJ5LlxuICAgIE9iamVjdC5rZXlzKHRoaXMucXVlcmllcykuZm9yRWFjaChxaWQgPT4ge1xuICAgICAgY29uc3QgcXVlcnkgPSB0aGlzLnF1ZXJpZXNbcWlkXTtcbiAgICAgIHF1ZXJ5LnJlc3VsdHNTbmFwc2hvdCA9IEVKU09OLmNsb25lKHF1ZXJ5LnJlc3VsdHMpO1xuICAgIH0pO1xuICB9XG5cbiAgcmVtb3ZlKHNlbGVjdG9yLCBjYWxsYmFjaykge1xuICAgIC8vIEVhc3kgc3BlY2lhbCBjYXNlOiBpZiB3ZSdyZSBub3QgY2FsbGluZyBvYnNlcnZlQ2hhbmdlcyBjYWxsYmFja3MgYW5kXG4gICAgLy8gd2UncmUgbm90IHNhdmluZyBvcmlnaW5hbHMgYW5kIHdlIGdvdCBhc2tlZCB0byByZW1vdmUgZXZlcnl0aGluZywgdGhlblxuICAgIC8vIGp1c3QgZW1wdHkgZXZlcnl0aGluZyBkaXJlY3RseS5cbiAgICBpZiAodGhpcy5wYXVzZWQgJiYgIXRoaXMuX3NhdmVkT3JpZ2luYWxzICYmIEVKU09OLmVxdWFscyhzZWxlY3Rvciwge30pKSB7XG4gICAgICBjb25zdCByZXN1bHQgPSB0aGlzLl9kb2NzLnNpemUoKTtcblxuICAgICAgdGhpcy5fZG9jcy5jbGVhcigpO1xuXG4gICAgICBPYmplY3Qua2V5cyh0aGlzLnF1ZXJpZXMpLmZvckVhY2gocWlkID0+IHtcbiAgICAgICAgY29uc3QgcXVlcnkgPSB0aGlzLnF1ZXJpZXNbcWlkXTtcblxuICAgICAgICBpZiAocXVlcnkub3JkZXJlZCkge1xuICAgICAgICAgIHF1ZXJ5LnJlc3VsdHMgPSBbXTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBxdWVyeS5yZXN1bHRzLmNsZWFyKCk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuXG4gICAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgICAgTWV0ZW9yLmRlZmVyKCgpID0+IHtcbiAgICAgICAgICBjYWxsYmFjayhudWxsLCByZXN1bHQpO1xuICAgICAgICB9KTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBjb25zdCBtYXRjaGVyID0gbmV3IE1pbmltb25nby5NYXRjaGVyKHNlbGVjdG9yKTtcbiAgICBjb25zdCByZW1vdmUgPSBbXTtcblxuICAgIHRoaXMuX2VhY2hQb3NzaWJseU1hdGNoaW5nRG9jKHNlbGVjdG9yLCAoZG9jLCBpZCkgPT4ge1xuICAgICAgaWYgKG1hdGNoZXIuZG9jdW1lbnRNYXRjaGVzKGRvYykucmVzdWx0KSB7XG4gICAgICAgIHJlbW92ZS5wdXNoKGlkKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIGNvbnN0IHF1ZXJpZXNUb1JlY29tcHV0ZSA9IFtdO1xuICAgIGNvbnN0IHF1ZXJ5UmVtb3ZlID0gW107XG5cbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IHJlbW92ZS5sZW5ndGg7IGkrKykge1xuICAgICAgY29uc3QgcmVtb3ZlSWQgPSByZW1vdmVbaV07XG4gICAgICBjb25zdCByZW1vdmVEb2MgPSB0aGlzLl9kb2NzLmdldChyZW1vdmVJZCk7XG5cbiAgICAgIE9iamVjdC5rZXlzKHRoaXMucXVlcmllcykuZm9yRWFjaChxaWQgPT4ge1xuICAgICAgICBjb25zdCBxdWVyeSA9IHRoaXMucXVlcmllc1txaWRdO1xuXG4gICAgICAgIGlmIChxdWVyeS5kaXJ0eSkge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChxdWVyeS5tYXRjaGVyLmRvY3VtZW50TWF0Y2hlcyhyZW1vdmVEb2MpLnJlc3VsdCkge1xuICAgICAgICAgIGlmIChxdWVyeS5jdXJzb3Iuc2tpcCB8fCBxdWVyeS5jdXJzb3IubGltaXQpIHtcbiAgICAgICAgICAgIHF1ZXJpZXNUb1JlY29tcHV0ZS5wdXNoKHFpZCk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHF1ZXJ5UmVtb3ZlLnB1c2goe3FpZCwgZG9jOiByZW1vdmVEb2N9KTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH0pO1xuXG4gICAgICB0aGlzLl9zYXZlT3JpZ2luYWwocmVtb3ZlSWQsIHJlbW92ZURvYyk7XG4gICAgICB0aGlzLl9kb2NzLnJlbW92ZShyZW1vdmVJZCk7XG4gICAgfVxuXG4gICAgLy8gcnVuIGxpdmUgcXVlcnkgY2FsbGJhY2tzIF9hZnRlcl8gd2UndmUgcmVtb3ZlZCB0aGUgZG9jdW1lbnRzLlxuICAgIHF1ZXJ5UmVtb3ZlLmZvckVhY2gocmVtb3ZlID0+IHtcbiAgICAgIGNvbnN0IHF1ZXJ5ID0gdGhpcy5xdWVyaWVzW3JlbW92ZS5xaWRdO1xuXG4gICAgICBpZiAocXVlcnkpIHtcbiAgICAgICAgcXVlcnkuZGlzdGFuY2VzICYmIHF1ZXJ5LmRpc3RhbmNlcy5yZW1vdmUocmVtb3ZlLmRvYy5faWQpO1xuICAgICAgICBMb2NhbENvbGxlY3Rpb24uX3JlbW92ZUZyb21SZXN1bHRzKHF1ZXJ5LCByZW1vdmUuZG9jKTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIHF1ZXJpZXNUb1JlY29tcHV0ZS5mb3JFYWNoKHFpZCA9PiB7XG4gICAgICBjb25zdCBxdWVyeSA9IHRoaXMucXVlcmllc1txaWRdO1xuXG4gICAgICBpZiAocXVlcnkpIHtcbiAgICAgICAgdGhpcy5fcmVjb21wdXRlUmVzdWx0cyhxdWVyeSk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICB0aGlzLl9vYnNlcnZlUXVldWUuZHJhaW4oKTtcblxuICAgIGNvbnN0IHJlc3VsdCA9IHJlbW92ZS5sZW5ndGg7XG5cbiAgICBpZiAoY2FsbGJhY2spIHtcbiAgICAgIE1ldGVvci5kZWZlcigoKSA9PiB7XG4gICAgICAgIGNhbGxiYWNrKG51bGwsIHJlc3VsdCk7XG4gICAgICB9KTtcbiAgICB9XG5cbiAgICByZXR1cm4gcmVzdWx0O1xuICB9XG5cbiAgLy8gUmVzdW1lIHRoZSBvYnNlcnZlcnMuIE9ic2VydmVycyBpbW1lZGlhdGVseSByZWNlaXZlIGNoYW5nZVxuICAvLyBub3RpZmljYXRpb25zIHRvIGJyaW5nIHRoZW0gdG8gdGhlIGN1cnJlbnQgc3RhdGUgb2YgdGhlXG4gIC8vIGRhdGFiYXNlLiBOb3RlIHRoYXQgdGhpcyBpcyBub3QganVzdCByZXBsYXlpbmcgYWxsIHRoZSBjaGFuZ2VzIHRoYXRcbiAgLy8gaGFwcGVuZWQgZHVyaW5nIHRoZSBwYXVzZSwgaXQgaXMgYSBzbWFydGVyICdjb2FsZXNjZWQnIGRpZmYuXG4gIHJlc3VtZU9ic2VydmVycygpIHtcbiAgICAvLyBOby1vcCBpZiBub3QgcGF1c2VkLlxuICAgIGlmICghdGhpcy5wYXVzZWQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBVbnNldCB0aGUgJ3BhdXNlZCcgZmxhZy4gTWFrZSBzdXJlIHRvIGRvIHRoaXMgZmlyc3QsIG90aGVyd2lzZVxuICAgIC8vIG9ic2VydmVyIG1ldGhvZHMgd29uJ3QgYWN0dWFsbHkgZmlyZSB3aGVuIHdlIHRyaWdnZXIgdGhlbS5cbiAgICB0aGlzLnBhdXNlZCA9IGZhbHNlO1xuXG4gICAgT2JqZWN0LmtleXModGhpcy5xdWVyaWVzKS5mb3JFYWNoKHFpZCA9PiB7XG4gICAgICBjb25zdCBxdWVyeSA9IHRoaXMucXVlcmllc1txaWRdO1xuXG4gICAgICBpZiAocXVlcnkuZGlydHkpIHtcbiAgICAgICAgcXVlcnkuZGlydHkgPSBmYWxzZTtcblxuICAgICAgICAvLyByZS1jb21wdXRlIHJlc3VsdHMgd2lsbCBwZXJmb3JtIGBMb2NhbENvbGxlY3Rpb24uX2RpZmZRdWVyeUNoYW5nZXNgXG4gICAgICAgIC8vIGF1dG9tYXRpY2FsbHkuXG4gICAgICAgIHRoaXMuX3JlY29tcHV0ZVJlc3VsdHMocXVlcnksIHF1ZXJ5LnJlc3VsdHNTbmFwc2hvdCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICAvLyBEaWZmIHRoZSBjdXJyZW50IHJlc3VsdHMgYWdhaW5zdCB0aGUgc25hcHNob3QgYW5kIHNlbmQgdG8gb2JzZXJ2ZXJzLlxuICAgICAgICAvLyBwYXNzIHRoZSBxdWVyeSBvYmplY3QgZm9yIGl0cyBvYnNlcnZlciBjYWxsYmFja3MuXG4gICAgICAgIExvY2FsQ29sbGVjdGlvbi5fZGlmZlF1ZXJ5Q2hhbmdlcyhcbiAgICAgICAgICBxdWVyeS5vcmRlcmVkLFxuICAgICAgICAgIHF1ZXJ5LnJlc3VsdHNTbmFwc2hvdCxcbiAgICAgICAgICBxdWVyeS5yZXN1bHRzLFxuICAgICAgICAgIHF1ZXJ5LFxuICAgICAgICAgIHtwcm9qZWN0aW9uRm46IHF1ZXJ5LnByb2plY3Rpb25Gbn1cbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgcXVlcnkucmVzdWx0c1NuYXBzaG90ID0gbnVsbDtcbiAgICB9KTtcblxuICAgIHRoaXMuX29ic2VydmVRdWV1ZS5kcmFpbigpO1xuICB9XG5cbiAgcmV0cmlldmVPcmlnaW5hbHMoKSB7XG4gICAgaWYgKCF0aGlzLl9zYXZlZE9yaWdpbmFscykge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdDYWxsZWQgcmV0cmlldmVPcmlnaW5hbHMgd2l0aG91dCBzYXZlT3JpZ2luYWxzJyk7XG4gICAgfVxuXG4gICAgY29uc3Qgb3JpZ2luYWxzID0gdGhpcy5fc2F2ZWRPcmlnaW5hbHM7XG5cbiAgICB0aGlzLl9zYXZlZE9yaWdpbmFscyA9IG51bGw7XG5cbiAgICByZXR1cm4gb3JpZ2luYWxzO1xuICB9XG5cbiAgLy8gVG8gdHJhY2sgd2hhdCBkb2N1bWVudHMgYXJlIGFmZmVjdGVkIGJ5IGEgcGllY2Ugb2YgY29kZSwgY2FsbFxuICAvLyBzYXZlT3JpZ2luYWxzKCkgYmVmb3JlIGl0IGFuZCByZXRyaWV2ZU9yaWdpbmFscygpIGFmdGVyIGl0LlxuICAvLyByZXRyaWV2ZU9yaWdpbmFscyByZXR1cm5zIGFuIG9iamVjdCB3aG9zZSBrZXlzIGFyZSB0aGUgaWRzIG9mIHRoZSBkb2N1bWVudHNcbiAgLy8gdGhhdCB3ZXJlIGFmZmVjdGVkIHNpbmNlIHRoZSBjYWxsIHRvIHNhdmVPcmlnaW5hbHMoKSwgYW5kIHRoZSB2YWx1ZXMgYXJlXG4gIC8vIGVxdWFsIHRvIHRoZSBkb2N1bWVudCdzIGNvbnRlbnRzIGF0IHRoZSB0aW1lIG9mIHNhdmVPcmlnaW5hbHMuIChJbiB0aGUgY2FzZVxuICAvLyBvZiBhbiBpbnNlcnRlZCBkb2N1bWVudCwgdW5kZWZpbmVkIGlzIHRoZSB2YWx1ZS4pIFlvdSBtdXN0IGFsdGVybmF0ZVxuICAvLyBiZXR3ZWVuIGNhbGxzIHRvIHNhdmVPcmlnaW5hbHMoKSBhbmQgcmV0cmlldmVPcmlnaW5hbHMoKS5cbiAgc2F2ZU9yaWdpbmFscygpIHtcbiAgICBpZiAodGhpcy5fc2F2ZWRPcmlnaW5hbHMpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcignQ2FsbGVkIHNhdmVPcmlnaW5hbHMgdHdpY2Ugd2l0aG91dCByZXRyaWV2ZU9yaWdpbmFscycpO1xuICAgIH1cblxuICAgIHRoaXMuX3NhdmVkT3JpZ2luYWxzID0gbmV3IExvY2FsQ29sbGVjdGlvbi5fSWRNYXA7XG4gIH1cblxuICAvLyBYWFggYXRvbWljaXR5OiBpZiBtdWx0aSBpcyB0cnVlLCBhbmQgb25lIG1vZGlmaWNhdGlvbiBmYWlscywgZG9cbiAgLy8gd2Ugcm9sbGJhY2sgdGhlIHdob2xlIG9wZXJhdGlvbiwgb3Igd2hhdD9cbiAgdXBkYXRlKHNlbGVjdG9yLCBtb2QsIG9wdGlvbnMsIGNhbGxiYWNrKSB7XG4gICAgaWYgKCEgY2FsbGJhY2sgJiYgb3B0aW9ucyBpbnN0YW5jZW9mIEZ1bmN0aW9uKSB7XG4gICAgICBjYWxsYmFjayA9IG9wdGlvbnM7XG4gICAgICBvcHRpb25zID0gbnVsbDtcbiAgICB9XG5cbiAgICBpZiAoIW9wdGlvbnMpIHtcbiAgICAgIG9wdGlvbnMgPSB7fTtcbiAgICB9XG5cbiAgICBjb25zdCBtYXRjaGVyID0gbmV3IE1pbmltb25nby5NYXRjaGVyKHNlbGVjdG9yLCB0cnVlKTtcblxuICAgIC8vIFNhdmUgdGhlIG9yaWdpbmFsIHJlc3VsdHMgb2YgYW55IHF1ZXJ5IHRoYXQgd2UgbWlnaHQgbmVlZCB0b1xuICAgIC8vIF9yZWNvbXB1dGVSZXN1bHRzIG9uLCBiZWNhdXNlIF9tb2RpZnlBbmROb3RpZnkgd2lsbCBtdXRhdGUgdGhlIG9iamVjdHMgaW5cbiAgICAvLyBpdC4gKFdlIGRvbid0IG5lZWQgdG8gc2F2ZSB0aGUgb3JpZ2luYWwgcmVzdWx0cyBvZiBwYXVzZWQgcXVlcmllcyBiZWNhdXNlXG4gICAgLy8gdGhleSBhbHJlYWR5IGhhdmUgYSByZXN1bHRzU25hcHNob3QgYW5kIHdlIHdvbid0IGJlIGRpZmZpbmcgaW5cbiAgICAvLyBfcmVjb21wdXRlUmVzdWx0cy4pXG4gICAgY29uc3QgcWlkVG9PcmlnaW5hbFJlc3VsdHMgPSB7fTtcblxuICAgIC8vIFdlIHNob3VsZCBvbmx5IGNsb25lIGVhY2ggZG9jdW1lbnQgb25jZSwgZXZlbiBpZiBpdCBhcHBlYXJzIGluIG11bHRpcGxlXG4gICAgLy8gcXVlcmllc1xuICAgIGNvbnN0IGRvY01hcCA9IG5ldyBMb2NhbENvbGxlY3Rpb24uX0lkTWFwO1xuICAgIGNvbnN0IGlkc01hdGNoZWQgPSBMb2NhbENvbGxlY3Rpb24uX2lkc01hdGNoZWRCeVNlbGVjdG9yKHNlbGVjdG9yKTtcblxuICAgIE9iamVjdC5rZXlzKHRoaXMucXVlcmllcykuZm9yRWFjaChxaWQgPT4ge1xuICAgICAgY29uc3QgcXVlcnkgPSB0aGlzLnF1ZXJpZXNbcWlkXTtcblxuICAgICAgaWYgKChxdWVyeS5jdXJzb3Iuc2tpcCB8fCBxdWVyeS5jdXJzb3IubGltaXQpICYmICEgdGhpcy5wYXVzZWQpIHtcbiAgICAgICAgLy8gQ2F0Y2ggdGhlIGNhc2Ugb2YgYSByZWFjdGl2ZSBgY291bnQoKWAgb24gYSBjdXJzb3Igd2l0aCBza2lwXG4gICAgICAgIC8vIG9yIGxpbWl0LCB3aGljaCByZWdpc3RlcnMgYW4gdW5vcmRlcmVkIG9ic2VydmUuIFRoaXMgaXMgYVxuICAgICAgICAvLyBwcmV0dHkgcmFyZSBjYXNlLCBzbyB3ZSBqdXN0IGNsb25lIHRoZSBlbnRpcmUgcmVzdWx0IHNldCB3aXRoXG4gICAgICAgIC8vIG5vIG9wdGltaXphdGlvbnMgZm9yIGRvY3VtZW50cyB0aGF0IGFwcGVhciBpbiB0aGVzZSByZXN1bHRcbiAgICAgICAgLy8gc2V0cyBhbmQgb3RoZXIgcXVlcmllcy5cbiAgICAgICAgaWYgKHF1ZXJ5LnJlc3VsdHMgaW5zdGFuY2VvZiBMb2NhbENvbGxlY3Rpb24uX0lkTWFwKSB7XG4gICAgICAgICAgcWlkVG9PcmlnaW5hbFJlc3VsdHNbcWlkXSA9IHF1ZXJ5LnJlc3VsdHMuY2xvbmUoKTtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIShxdWVyeS5yZXN1bHRzIGluc3RhbmNlb2YgQXJyYXkpKSB7XG4gICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdBc3NlcnRpb24gZmFpbGVkOiBxdWVyeS5yZXN1bHRzIG5vdCBhbiBhcnJheScpO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gQ2xvbmVzIGEgZG9jdW1lbnQgdG8gYmUgc3RvcmVkIGluIGBxaWRUb09yaWdpbmFsUmVzdWx0c2BcbiAgICAgICAgLy8gYmVjYXVzZSBpdCBtYXkgYmUgbW9kaWZpZWQgYmVmb3JlIHRoZSBuZXcgYW5kIG9sZCByZXN1bHQgc2V0c1xuICAgICAgICAvLyBhcmUgZGlmZmVkLiBCdXQgaWYgd2Uga25vdyBleGFjdGx5IHdoaWNoIGRvY3VtZW50IElEcyB3ZSdyZVxuICAgICAgICAvLyBnb2luZyB0byBtb2RpZnksIHRoZW4gd2Ugb25seSBuZWVkIHRvIGNsb25lIHRob3NlLlxuICAgICAgICBjb25zdCBtZW1vaXplZENsb25lSWZOZWVkZWQgPSBkb2MgPT4ge1xuICAgICAgICAgIGlmIChkb2NNYXAuaGFzKGRvYy5faWQpKSB7XG4gICAgICAgICAgICByZXR1cm4gZG9jTWFwLmdldChkb2MuX2lkKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBjb25zdCBkb2NUb01lbW9pemUgPSAoXG4gICAgICAgICAgICBpZHNNYXRjaGVkICYmXG4gICAgICAgICAgICAhaWRzTWF0Y2hlZC5zb21lKGlkID0+IEVKU09OLmVxdWFscyhpZCwgZG9jLl9pZCkpXG4gICAgICAgICAgKSA/IGRvYyA6IEVKU09OLmNsb25lKGRvYyk7XG5cbiAgICAgICAgICBkb2NNYXAuc2V0KGRvYy5faWQsIGRvY1RvTWVtb2l6ZSk7XG5cbiAgICAgICAgICByZXR1cm4gZG9jVG9NZW1vaXplO1xuICAgICAgICB9O1xuXG4gICAgICAgIHFpZFRvT3JpZ2luYWxSZXN1bHRzW3FpZF0gPSBxdWVyeS5yZXN1bHRzLm1hcChtZW1vaXplZENsb25lSWZOZWVkZWQpO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgY29uc3QgcmVjb21wdXRlUWlkcyA9IHt9O1xuXG4gICAgbGV0IHVwZGF0ZUNvdW50ID0gMDtcblxuICAgIHRoaXMuX2VhY2hQb3NzaWJseU1hdGNoaW5nRG9jKHNlbGVjdG9yLCAoZG9jLCBpZCkgPT4ge1xuICAgICAgY29uc3QgcXVlcnlSZXN1bHQgPSBtYXRjaGVyLmRvY3VtZW50TWF0Y2hlcyhkb2MpO1xuXG4gICAgICBpZiAocXVlcnlSZXN1bHQucmVzdWx0KSB7XG4gICAgICAgIC8vIFhYWCBTaG91bGQgd2Ugc2F2ZSB0aGUgb3JpZ2luYWwgZXZlbiBpZiBtb2QgZW5kcyB1cCBiZWluZyBhIG5vLW9wP1xuICAgICAgICB0aGlzLl9zYXZlT3JpZ2luYWwoaWQsIGRvYyk7XG4gICAgICAgIHRoaXMuX21vZGlmeUFuZE5vdGlmeShcbiAgICAgICAgICBkb2MsXG4gICAgICAgICAgbW9kLFxuICAgICAgICAgIHJlY29tcHV0ZVFpZHMsXG4gICAgICAgICAgcXVlcnlSZXN1bHQuYXJyYXlJbmRpY2VzXG4gICAgICAgICk7XG5cbiAgICAgICAgKyt1cGRhdGVDb3VudDtcblxuICAgICAgICBpZiAoIW9wdGlvbnMubXVsdGkpIHtcbiAgICAgICAgICByZXR1cm4gZmFsc2U7IC8vIGJyZWFrXG4gICAgICAgIH1cbiAgICAgIH1cblxuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfSk7XG5cbiAgICBPYmplY3Qua2V5cyhyZWNvbXB1dGVRaWRzKS5mb3JFYWNoKHFpZCA9PiB7XG4gICAgICBjb25zdCBxdWVyeSA9IHRoaXMucXVlcmllc1txaWRdO1xuXG4gICAgICBpZiAocXVlcnkpIHtcbiAgICAgICAgdGhpcy5fcmVjb21wdXRlUmVzdWx0cyhxdWVyeSwgcWlkVG9PcmlnaW5hbFJlc3VsdHNbcWlkXSk7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICB0aGlzLl9vYnNlcnZlUXVldWUuZHJhaW4oKTtcblxuICAgIC8vIElmIHdlIGFyZSBkb2luZyBhbiB1cHNlcnQsIGFuZCB3ZSBkaWRuJ3QgbW9kaWZ5IGFueSBkb2N1bWVudHMgeWV0LCB0aGVuXG4gICAgLy8gaXQncyB0aW1lIHRvIGRvIGFuIGluc2VydC4gRmlndXJlIG91dCB3aGF0IGRvY3VtZW50IHdlIGFyZSBpbnNlcnRpbmcsIGFuZFxuICAgIC8vIGdlbmVyYXRlIGFuIGlkIGZvciBpdC5cbiAgICBsZXQgaW5zZXJ0ZWRJZDtcbiAgICBpZiAodXBkYXRlQ291bnQgPT09IDAgJiYgb3B0aW9ucy51cHNlcnQpIHtcbiAgICAgIGNvbnN0IGRvYyA9IExvY2FsQ29sbGVjdGlvbi5fY3JlYXRlVXBzZXJ0RG9jdW1lbnQoc2VsZWN0b3IsIG1vZCk7XG4gICAgICBpZiAoISBkb2MuX2lkICYmIG9wdGlvbnMuaW5zZXJ0ZWRJZCkge1xuICAgICAgICBkb2MuX2lkID0gb3B0aW9ucy5pbnNlcnRlZElkO1xuICAgICAgfVxuXG4gICAgICBpbnNlcnRlZElkID0gdGhpcy5pbnNlcnQoZG9jKTtcbiAgICAgIHVwZGF0ZUNvdW50ID0gMTtcbiAgICB9XG5cbiAgICAvLyBSZXR1cm4gdGhlIG51bWJlciBvZiBhZmZlY3RlZCBkb2N1bWVudHMsIG9yIGluIHRoZSB1cHNlcnQgY2FzZSwgYW4gb2JqZWN0XG4gICAgLy8gY29udGFpbmluZyB0aGUgbnVtYmVyIG9mIGFmZmVjdGVkIGRvY3MgYW5kIHRoZSBpZCBvZiB0aGUgZG9jIHRoYXQgd2FzXG4gICAgLy8gaW5zZXJ0ZWQsIGlmIGFueS5cbiAgICBsZXQgcmVzdWx0O1xuICAgIGlmIChvcHRpb25zLl9yZXR1cm5PYmplY3QpIHtcbiAgICAgIHJlc3VsdCA9IHtudW1iZXJBZmZlY3RlZDogdXBkYXRlQ291bnR9O1xuXG4gICAgICBpZiAoaW5zZXJ0ZWRJZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHJlc3VsdC5pbnNlcnRlZElkID0gaW5zZXJ0ZWRJZDtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgcmVzdWx0ID0gdXBkYXRlQ291bnQ7XG4gICAgfVxuXG4gICAgaWYgKGNhbGxiYWNrKSB7XG4gICAgICBNZXRlb3IuZGVmZXIoKCkgPT4ge1xuICAgICAgICBjYWxsYmFjayhudWxsLCByZXN1bHQpO1xuICAgICAgfSk7XG4gICAgfVxuXG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfVxuXG4gIC8vIEEgY29udmVuaWVuY2Ugd3JhcHBlciBvbiB1cGRhdGUuIExvY2FsQ29sbGVjdGlvbi51cHNlcnQoc2VsLCBtb2QpIGlzXG4gIC8vIGVxdWl2YWxlbnQgdG8gTG9jYWxDb2xsZWN0aW9uLnVwZGF0ZShzZWwsIG1vZCwge3Vwc2VydDogdHJ1ZSxcbiAgLy8gX3JldHVybk9iamVjdDogdHJ1ZX0pLlxuICB1cHNlcnQoc2VsZWN0b3IsIG1vZCwgb3B0aW9ucywgY2FsbGJhY2spIHtcbiAgICBpZiAoIWNhbGxiYWNrICYmIHR5cGVvZiBvcHRpb25zID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICBjYWxsYmFjayA9IG9wdGlvbnM7XG4gICAgICBvcHRpb25zID0ge307XG4gICAgfVxuXG4gICAgcmV0dXJuIHRoaXMudXBkYXRlKFxuICAgICAgc2VsZWN0b3IsXG4gICAgICBtb2QsXG4gICAgICBPYmplY3QuYXNzaWduKHt9LCBvcHRpb25zLCB7dXBzZXJ0OiB0cnVlLCBfcmV0dXJuT2JqZWN0OiB0cnVlfSksXG4gICAgICBjYWxsYmFja1xuICAgICk7XG4gIH1cblxuICAvLyBJdGVyYXRlcyBvdmVyIGEgc3Vic2V0IG9mIGRvY3VtZW50cyB0aGF0IGNvdWxkIG1hdGNoIHNlbGVjdG9yOyBjYWxsc1xuICAvLyBmbihkb2MsIGlkKSBvbiBlYWNoIG9mIHRoZW0uICBTcGVjaWZpY2FsbHksIGlmIHNlbGVjdG9yIHNwZWNpZmllc1xuICAvLyBzcGVjaWZpYyBfaWQncywgaXQgb25seSBsb29rcyBhdCB0aG9zZS4gIGRvYyBpcyAqbm90KiBjbG9uZWQ6IGl0IGlzIHRoZVxuICAvLyBzYW1lIG9iamVjdCB0aGF0IGlzIGluIF9kb2NzLlxuICBfZWFjaFBvc3NpYmx5TWF0Y2hpbmdEb2Moc2VsZWN0b3IsIGZuKSB7XG4gICAgY29uc3Qgc3BlY2lmaWNJZHMgPSBMb2NhbENvbGxlY3Rpb24uX2lkc01hdGNoZWRCeVNlbGVjdG9yKHNlbGVjdG9yKTtcblxuICAgIGlmIChzcGVjaWZpY0lkcykge1xuICAgICAgc3BlY2lmaWNJZHMuc29tZShpZCA9PiB7XG4gICAgICAgIGNvbnN0IGRvYyA9IHRoaXMuX2RvY3MuZ2V0KGlkKTtcblxuICAgICAgICBpZiAoZG9jKSB7XG4gICAgICAgICAgcmV0dXJuIGZuKGRvYywgaWQpID09PSBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRoaXMuX2RvY3MuZm9yRWFjaChmbik7XG4gICAgfVxuICB9XG5cbiAgX21vZGlmeUFuZE5vdGlmeShkb2MsIG1vZCwgcmVjb21wdXRlUWlkcywgYXJyYXlJbmRpY2VzKSB7XG4gICAgY29uc3QgbWF0Y2hlZF9iZWZvcmUgPSB7fTtcblxuICAgIE9iamVjdC5rZXlzKHRoaXMucXVlcmllcykuZm9yRWFjaChxaWQgPT4ge1xuICAgICAgY29uc3QgcXVlcnkgPSB0aGlzLnF1ZXJpZXNbcWlkXTtcblxuICAgICAgaWYgKHF1ZXJ5LmRpcnR5KSB7XG4gICAgICAgIHJldHVybjtcbiAgICAgIH1cblxuICAgICAgaWYgKHF1ZXJ5Lm9yZGVyZWQpIHtcbiAgICAgICAgbWF0Y2hlZF9iZWZvcmVbcWlkXSA9IHF1ZXJ5Lm1hdGNoZXIuZG9jdW1lbnRNYXRjaGVzKGRvYykucmVzdWx0O1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgLy8gQmVjYXVzZSB3ZSBkb24ndCBzdXBwb3J0IHNraXAgb3IgbGltaXQgKHlldCkgaW4gdW5vcmRlcmVkIHF1ZXJpZXMsIHdlXG4gICAgICAgIC8vIGNhbiBqdXN0IGRvIGEgZGlyZWN0IGxvb2t1cC5cbiAgICAgICAgbWF0Y2hlZF9iZWZvcmVbcWlkXSA9IHF1ZXJ5LnJlc3VsdHMuaGFzKGRvYy5faWQpO1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgY29uc3Qgb2xkX2RvYyA9IEVKU09OLmNsb25lKGRvYyk7XG5cbiAgICBMb2NhbENvbGxlY3Rpb24uX21vZGlmeShkb2MsIG1vZCwge2FycmF5SW5kaWNlc30pO1xuXG4gICAgT2JqZWN0LmtleXModGhpcy5xdWVyaWVzKS5mb3JFYWNoKHFpZCA9PiB7XG4gICAgICBjb25zdCBxdWVyeSA9IHRoaXMucXVlcmllc1txaWRdO1xuXG4gICAgICBpZiAocXVlcnkuZGlydHkpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBhZnRlck1hdGNoID0gcXVlcnkubWF0Y2hlci5kb2N1bWVudE1hdGNoZXMoZG9jKTtcbiAgICAgIGNvbnN0IGFmdGVyID0gYWZ0ZXJNYXRjaC5yZXN1bHQ7XG4gICAgICBjb25zdCBiZWZvcmUgPSBtYXRjaGVkX2JlZm9yZVtxaWRdO1xuXG4gICAgICBpZiAoYWZ0ZXIgJiYgcXVlcnkuZGlzdGFuY2VzICYmIGFmdGVyTWF0Y2guZGlzdGFuY2UgIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBxdWVyeS5kaXN0YW5jZXMuc2V0KGRvYy5faWQsIGFmdGVyTWF0Y2guZGlzdGFuY2UpO1xuICAgICAgfVxuXG4gICAgICBpZiAocXVlcnkuY3Vyc29yLnNraXAgfHwgcXVlcnkuY3Vyc29yLmxpbWl0KSB7XG4gICAgICAgIC8vIFdlIG5lZWQgdG8gcmVjb21wdXRlIGFueSBxdWVyeSB3aGVyZSB0aGUgZG9jIG1heSBoYXZlIGJlZW4gaW4gdGhlXG4gICAgICAgIC8vIGN1cnNvcidzIHdpbmRvdyBlaXRoZXIgYmVmb3JlIG9yIGFmdGVyIHRoZSB1cGRhdGUuIChOb3RlIHRoYXQgaWYgc2tpcFxuICAgICAgICAvLyBvciBsaW1pdCBpcyBzZXQsIFwiYmVmb3JlXCIgYW5kIFwiYWZ0ZXJcIiBiZWluZyB0cnVlIGRvIG5vdCBuZWNlc3NhcmlseVxuICAgICAgICAvLyBtZWFuIHRoYXQgdGhlIGRvY3VtZW50IGlzIGluIHRoZSBjdXJzb3IncyBvdXRwdXQgYWZ0ZXIgc2tpcC9saW1pdCBpc1xuICAgICAgICAvLyBhcHBsaWVkLi4uIGJ1dCBpZiB0aGV5IGFyZSBmYWxzZSwgdGhlbiB0aGUgZG9jdW1lbnQgZGVmaW5pdGVseSBpcyBOT1RcbiAgICAgICAgLy8gaW4gdGhlIG91dHB1dC4gU28gaXQncyBzYWZlIHRvIHNraXAgcmVjb21wdXRlIGlmIG5laXRoZXIgYmVmb3JlIG9yXG4gICAgICAgIC8vIGFmdGVyIGFyZSB0cnVlLilcbiAgICAgICAgaWYgKGJlZm9yZSB8fCBhZnRlcikge1xuICAgICAgICAgIHJlY29tcHV0ZVFpZHNbcWlkXSA9IHRydWU7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSBpZiAoYmVmb3JlICYmICFhZnRlcikge1xuICAgICAgICBMb2NhbENvbGxlY3Rpb24uX3JlbW92ZUZyb21SZXN1bHRzKHF1ZXJ5LCBkb2MpO1xuICAgICAgfSBlbHNlIGlmICghYmVmb3JlICYmIGFmdGVyKSB7XG4gICAgICAgIExvY2FsQ29sbGVjdGlvbi5faW5zZXJ0SW5SZXN1bHRzKHF1ZXJ5LCBkb2MpO1xuICAgICAgfSBlbHNlIGlmIChiZWZvcmUgJiYgYWZ0ZXIpIHtcbiAgICAgICAgTG9jYWxDb2xsZWN0aW9uLl91cGRhdGVJblJlc3VsdHMocXVlcnksIGRvYywgb2xkX2RvYyk7XG4gICAgICB9XG4gICAgfSk7XG4gIH1cblxuICAvLyBSZWNvbXB1dGVzIHRoZSByZXN1bHRzIG9mIGEgcXVlcnkgYW5kIHJ1bnMgb2JzZXJ2ZSBjYWxsYmFja3MgZm9yIHRoZVxuICAvLyBkaWZmZXJlbmNlIGJldHdlZW4gdGhlIHByZXZpb3VzIHJlc3VsdHMgYW5kIHRoZSBjdXJyZW50IHJlc3VsdHMgKHVubGVzc1xuICAvLyBwYXVzZWQpLiBVc2VkIGZvciBza2lwL2xpbWl0IHF1ZXJpZXMuXG4gIC8vXG4gIC8vIFdoZW4gdGhpcyBpcyB1c2VkIGJ5IGluc2VydCBvciByZW1vdmUsIGl0IGNhbiBqdXN0IHVzZSBxdWVyeS5yZXN1bHRzIGZvclxuICAvLyB0aGUgb2xkIHJlc3VsdHMgKGFuZCB0aGVyZSdzIG5vIG5lZWQgdG8gcGFzcyBpbiBvbGRSZXN1bHRzKSwgYmVjYXVzZSB0aGVzZVxuICAvLyBvcGVyYXRpb25zIGRvbid0IG11dGF0ZSB0aGUgZG9jdW1lbnRzIGluIHRoZSBjb2xsZWN0aW9uLiBVcGRhdGUgbmVlZHMgdG9cbiAgLy8gcGFzcyBpbiBhbiBvbGRSZXN1bHRzIHdoaWNoIHdhcyBkZWVwLWNvcGllZCBiZWZvcmUgdGhlIG1vZGlmaWVyIHdhc1xuICAvLyBhcHBsaWVkLlxuICAvL1xuICAvLyBvbGRSZXN1bHRzIGlzIGd1YXJhbnRlZWQgdG8gYmUgaWdub3JlZCBpZiB0aGUgcXVlcnkgaXMgbm90IHBhdXNlZC5cbiAgX3JlY29tcHV0ZVJlc3VsdHMocXVlcnksIG9sZFJlc3VsdHMpIHtcbiAgICBpZiAodGhpcy5wYXVzZWQpIHtcbiAgICAgIC8vIFRoZXJlJ3Mgbm8gcmVhc29uIHRvIHJlY29tcHV0ZSB0aGUgcmVzdWx0cyBub3cgYXMgd2UncmUgc3RpbGwgcGF1c2VkLlxuICAgICAgLy8gQnkgZmxhZ2dpbmcgdGhlIHF1ZXJ5IGFzIFwiZGlydHlcIiwgdGhlIHJlY29tcHV0ZSB3aWxsIGJlIHBlcmZvcm1lZFxuICAgICAgLy8gd2hlbiByZXN1bWVPYnNlcnZlcnMgaXMgY2FsbGVkLlxuICAgICAgcXVlcnkuZGlydHkgPSB0cnVlO1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGlmICghdGhpcy5wYXVzZWQgJiYgIW9sZFJlc3VsdHMpIHtcbiAgICAgIG9sZFJlc3VsdHMgPSBxdWVyeS5yZXN1bHRzO1xuICAgIH1cblxuICAgIGlmIChxdWVyeS5kaXN0YW5jZXMpIHtcbiAgICAgIHF1ZXJ5LmRpc3RhbmNlcy5jbGVhcigpO1xuICAgIH1cblxuICAgIHF1ZXJ5LnJlc3VsdHMgPSBxdWVyeS5jdXJzb3IuX2dldFJhd09iamVjdHMoe1xuICAgICAgZGlzdGFuY2VzOiBxdWVyeS5kaXN0YW5jZXMsXG4gICAgICBvcmRlcmVkOiBxdWVyeS5vcmRlcmVkXG4gICAgfSk7XG5cbiAgICBpZiAoIXRoaXMucGF1c2VkKSB7XG4gICAgICBMb2NhbENvbGxlY3Rpb24uX2RpZmZRdWVyeUNoYW5nZXMoXG4gICAgICAgIHF1ZXJ5Lm9yZGVyZWQsXG4gICAgICAgIG9sZFJlc3VsdHMsXG4gICAgICAgIHF1ZXJ5LnJlc3VsdHMsXG4gICAgICAgIHF1ZXJ5LFxuICAgICAgICB7cHJvamVjdGlvbkZuOiBxdWVyeS5wcm9qZWN0aW9uRm59XG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIF9zYXZlT3JpZ2luYWwoaWQsIGRvYykge1xuICAgIC8vIEFyZSB3ZSBldmVuIHRyeWluZyB0byBzYXZlIG9yaWdpbmFscz9cbiAgICBpZiAoIXRoaXMuX3NhdmVkT3JpZ2luYWxzKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gSGF2ZSB3ZSBwcmV2aW91c2x5IG11dGF0ZWQgdGhlIG9yaWdpbmFsIChhbmQgc28gJ2RvYycgaXMgbm90IGFjdHVhbGx5XG4gICAgLy8gb3JpZ2luYWwpPyAgKE5vdGUgdGhlICdoYXMnIGNoZWNrIHJhdGhlciB0aGFuIHRydXRoOiB3ZSBzdG9yZSB1bmRlZmluZWRcbiAgICAvLyBoZXJlIGZvciBpbnNlcnRlZCBkb2NzISlcbiAgICBpZiAodGhpcy5fc2F2ZWRPcmlnaW5hbHMuaGFzKGlkKSkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIHRoaXMuX3NhdmVkT3JpZ2luYWxzLnNldChpZCwgRUpTT04uY2xvbmUoZG9jKSk7XG4gIH1cbn1cblxuTG9jYWxDb2xsZWN0aW9uLkN1cnNvciA9IEN1cnNvcjtcblxuTG9jYWxDb2xsZWN0aW9uLk9ic2VydmVIYW5kbGUgPSBPYnNlcnZlSGFuZGxlO1xuXG4vLyBYWFggbWF5YmUgbW92ZSB0aGVzZSBpbnRvIGFub3RoZXIgT2JzZXJ2ZUhlbHBlcnMgcGFja2FnZSBvciBzb21ldGhpbmdcblxuLy8gX0NhY2hpbmdDaGFuZ2VPYnNlcnZlciBpcyBhbiBvYmplY3Qgd2hpY2ggcmVjZWl2ZXMgb2JzZXJ2ZUNoYW5nZXMgY2FsbGJhY2tzXG4vLyBhbmQga2VlcHMgYSBjYWNoZSBvZiB0aGUgY3VycmVudCBjdXJzb3Igc3RhdGUgdXAgdG8gZGF0ZSBpbiB0aGlzLmRvY3MuIFVzZXJzXG4vLyBvZiB0aGlzIGNsYXNzIHNob3VsZCByZWFkIHRoZSBkb2NzIGZpZWxkIGJ1dCBub3QgbW9kaWZ5IGl0LiBZb3Ugc2hvdWxkIHBhc3Ncbi8vIHRoZSBcImFwcGx5Q2hhbmdlXCIgZmllbGQgYXMgdGhlIGNhbGxiYWNrcyB0byB0aGUgdW5kZXJseWluZyBvYnNlcnZlQ2hhbmdlc1xuLy8gY2FsbC4gT3B0aW9uYWxseSwgeW91IGNhbiBzcGVjaWZ5IHlvdXIgb3duIG9ic2VydmVDaGFuZ2VzIGNhbGxiYWNrcyB3aGljaCBhcmVcbi8vIGludm9rZWQgaW1tZWRpYXRlbHkgYmVmb3JlIHRoZSBkb2NzIGZpZWxkIGlzIHVwZGF0ZWQ7IHRoaXMgb2JqZWN0IGlzIG1hZGVcbi8vIGF2YWlsYWJsZSBhcyBgdGhpc2AgdG8gdGhvc2UgY2FsbGJhY2tzLlxuTG9jYWxDb2xsZWN0aW9uLl9DYWNoaW5nQ2hhbmdlT2JzZXJ2ZXIgPSBjbGFzcyBfQ2FjaGluZ0NoYW5nZU9ic2VydmVyIHtcbiAgY29uc3RydWN0b3Iob3B0aW9ucyA9IHt9KSB7XG4gICAgY29uc3Qgb3JkZXJlZEZyb21DYWxsYmFja3MgPSAoXG4gICAgICBvcHRpb25zLmNhbGxiYWNrcyAmJlxuICAgICAgTG9jYWxDb2xsZWN0aW9uLl9vYnNlcnZlQ2hhbmdlc0NhbGxiYWNrc0FyZU9yZGVyZWQob3B0aW9ucy5jYWxsYmFja3MpXG4gICAgKTtcblxuICAgIGlmIChoYXNPd24uY2FsbChvcHRpb25zLCAnb3JkZXJlZCcpKSB7XG4gICAgICB0aGlzLm9yZGVyZWQgPSBvcHRpb25zLm9yZGVyZWQ7XG5cbiAgICAgIGlmIChvcHRpb25zLmNhbGxiYWNrcyAmJiBvcHRpb25zLm9yZGVyZWQgIT09IG9yZGVyZWRGcm9tQ2FsbGJhY2tzKSB7XG4gICAgICAgIHRocm93IEVycm9yKCdvcmRlcmVkIG9wdGlvbiBkb2VzblxcJ3QgbWF0Y2ggY2FsbGJhY2tzJyk7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmIChvcHRpb25zLmNhbGxiYWNrcykge1xuICAgICAgdGhpcy5vcmRlcmVkID0gb3JkZXJlZEZyb21DYWxsYmFja3M7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93IEVycm9yKCdtdXN0IHByb3ZpZGUgb3JkZXJlZCBvciBjYWxsYmFja3MnKTtcbiAgICB9XG5cbiAgICBjb25zdCBjYWxsYmFja3MgPSBvcHRpb25zLmNhbGxiYWNrcyB8fCB7fTtcblxuICAgIGlmICh0aGlzLm9yZGVyZWQpIHtcbiAgICAgIHRoaXMuZG9jcyA9IG5ldyBPcmRlcmVkRGljdChNb25nb0lELmlkU3RyaW5naWZ5KTtcbiAgICAgIHRoaXMuYXBwbHlDaGFuZ2UgPSB7XG4gICAgICAgIGFkZGVkQmVmb3JlOiAoaWQsIGZpZWxkcywgYmVmb3JlKSA9PiB7XG4gICAgICAgICAgLy8gVGFrZSBhIHNoYWxsb3cgY29weSBzaW5jZSB0aGUgdG9wLWxldmVsIHByb3BlcnRpZXMgY2FuIGJlIGNoYW5nZWRcbiAgICAgICAgICBjb25zdCBkb2MgPSB7IC4uLmZpZWxkcyB9O1xuXG4gICAgICAgICAgZG9jLl9pZCA9IGlkO1xuXG4gICAgICAgICAgaWYgKGNhbGxiYWNrcy5hZGRlZEJlZm9yZSkge1xuICAgICAgICAgICAgY2FsbGJhY2tzLmFkZGVkQmVmb3JlLmNhbGwodGhpcywgaWQsIEVKU09OLmNsb25lKGZpZWxkcyksIGJlZm9yZSk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gVGhpcyBsaW5lIHRyaWdnZXJzIGlmIHdlIHByb3ZpZGUgYWRkZWQgd2l0aCBtb3ZlZEJlZm9yZS5cbiAgICAgICAgICBpZiAoY2FsbGJhY2tzLmFkZGVkKSB7XG4gICAgICAgICAgICBjYWxsYmFja3MuYWRkZWQuY2FsbCh0aGlzLCBpZCwgRUpTT04uY2xvbmUoZmllbGRzKSk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgLy8gWFhYIGNvdWxkIGBiZWZvcmVgIGJlIGEgZmFsc3kgSUQ/ICBUZWNobmljYWxseVxuICAgICAgICAgIC8vIGlkU3RyaW5naWZ5IHNlZW1zIHRvIGFsbG93IGZvciB0aGVtIC0tIHRob3VnaFxuICAgICAgICAgIC8vIE9yZGVyZWREaWN0IHdvbid0IGNhbGwgc3RyaW5naWZ5IG9uIGEgZmFsc3kgYXJnLlxuICAgICAgICAgIHRoaXMuZG9jcy5wdXRCZWZvcmUoaWQsIGRvYywgYmVmb3JlIHx8IG51bGwpO1xuICAgICAgICB9LFxuICAgICAgICBtb3ZlZEJlZm9yZTogKGlkLCBiZWZvcmUpID0+IHtcbiAgICAgICAgICBjb25zdCBkb2MgPSB0aGlzLmRvY3MuZ2V0KGlkKTtcblxuICAgICAgICAgIGlmIChjYWxsYmFja3MubW92ZWRCZWZvcmUpIHtcbiAgICAgICAgICAgIGNhbGxiYWNrcy5tb3ZlZEJlZm9yZS5jYWxsKHRoaXMsIGlkLCBiZWZvcmUpO1xuICAgICAgICAgIH1cblxuICAgICAgICAgIHRoaXMuZG9jcy5tb3ZlQmVmb3JlKGlkLCBiZWZvcmUgfHwgbnVsbCk7XG4gICAgICAgIH0sXG4gICAgICB9O1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLmRvY3MgPSBuZXcgTG9jYWxDb2xsZWN0aW9uLl9JZE1hcDtcbiAgICAgIHRoaXMuYXBwbHlDaGFuZ2UgPSB7XG4gICAgICAgIGFkZGVkOiAoaWQsIGZpZWxkcykgPT4ge1xuICAgICAgICAgIC8vIFRha2UgYSBzaGFsbG93IGNvcHkgc2luY2UgdGhlIHRvcC1sZXZlbCBwcm9wZXJ0aWVzIGNhbiBiZSBjaGFuZ2VkXG4gICAgICAgICAgY29uc3QgZG9jID0geyAuLi5maWVsZHMgfTtcblxuICAgICAgICAgIGlmIChjYWxsYmFja3MuYWRkZWQpIHtcbiAgICAgICAgICAgIGNhbGxiYWNrcy5hZGRlZC5jYWxsKHRoaXMsIGlkLCBFSlNPTi5jbG9uZShmaWVsZHMpKTtcbiAgICAgICAgICB9XG5cbiAgICAgICAgICBkb2MuX2lkID0gaWQ7XG5cbiAgICAgICAgICB0aGlzLmRvY3Muc2V0KGlkLCAgZG9jKTtcbiAgICAgICAgfSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgLy8gVGhlIG1ldGhvZHMgaW4gX0lkTWFwIGFuZCBPcmRlcmVkRGljdCB1c2VkIGJ5IHRoZXNlIGNhbGxiYWNrcyBhcmVcbiAgICAvLyBpZGVudGljYWwuXG4gICAgdGhpcy5hcHBseUNoYW5nZS5jaGFuZ2VkID0gKGlkLCBmaWVsZHMpID0+IHtcbiAgICAgIGNvbnN0IGRvYyA9IHRoaXMuZG9jcy5nZXQoaWQpO1xuXG4gICAgICBpZiAoIWRvYykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFVua25vd24gaWQgZm9yIGNoYW5nZWQ6ICR7aWR9YCk7XG4gICAgICB9XG5cbiAgICAgIGlmIChjYWxsYmFja3MuY2hhbmdlZCkge1xuICAgICAgICBjYWxsYmFja3MuY2hhbmdlZC5jYWxsKHRoaXMsIGlkLCBFSlNPTi5jbG9uZShmaWVsZHMpKTtcbiAgICAgIH1cblxuICAgICAgRGlmZlNlcXVlbmNlLmFwcGx5Q2hhbmdlcyhkb2MsIGZpZWxkcyk7XG4gICAgfTtcblxuICAgIHRoaXMuYXBwbHlDaGFuZ2UucmVtb3ZlZCA9IGlkID0+IHtcbiAgICAgIGlmIChjYWxsYmFja3MucmVtb3ZlZCkge1xuICAgICAgICBjYWxsYmFja3MucmVtb3ZlZC5jYWxsKHRoaXMsIGlkKTtcbiAgICAgIH1cblxuICAgICAgdGhpcy5kb2NzLnJlbW92ZShpZCk7XG4gICAgfTtcbiAgfVxufTtcblxuTG9jYWxDb2xsZWN0aW9uLl9JZE1hcCA9IGNsYXNzIF9JZE1hcCBleHRlbmRzIElkTWFwIHtcbiAgY29uc3RydWN0b3IoKSB7XG4gICAgc3VwZXIoTW9uZ29JRC5pZFN0cmluZ2lmeSwgTW9uZ29JRC5pZFBhcnNlKTtcbiAgfVxufTtcblxuLy8gV3JhcCBhIHRyYW5zZm9ybSBmdW5jdGlvbiB0byByZXR1cm4gb2JqZWN0cyB0aGF0IGhhdmUgdGhlIF9pZCBmaWVsZFxuLy8gb2YgdGhlIHVudHJhbnNmb3JtZWQgZG9jdW1lbnQuIFRoaXMgZW5zdXJlcyB0aGF0IHN1YnN5c3RlbXMgc3VjaCBhc1xuLy8gdGhlIG9ic2VydmUtc2VxdWVuY2UgcGFja2FnZSB0aGF0IGNhbGwgYG9ic2VydmVgIGNhbiBrZWVwIHRyYWNrIG9mXG4vLyB0aGUgZG9jdW1lbnRzIGlkZW50aXRpZXMuXG4vL1xuLy8gLSBSZXF1aXJlIHRoYXQgaXQgcmV0dXJucyBvYmplY3RzXG4vLyAtIElmIHRoZSByZXR1cm4gdmFsdWUgaGFzIGFuIF9pZCBmaWVsZCwgdmVyaWZ5IHRoYXQgaXQgbWF0Y2hlcyB0aGVcbi8vICAgb3JpZ2luYWwgX2lkIGZpZWxkXG4vLyAtIElmIHRoZSByZXR1cm4gdmFsdWUgZG9lc24ndCBoYXZlIGFuIF9pZCBmaWVsZCwgYWRkIGl0IGJhY2suXG5Mb2NhbENvbGxlY3Rpb24ud3JhcFRyYW5zZm9ybSA9IHRyYW5zZm9ybSA9PiB7XG4gIGlmICghdHJhbnNmb3JtKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cblxuICAvLyBObyBuZWVkIHRvIGRvdWJseS13cmFwIHRyYW5zZm9ybXMuXG4gIGlmICh0cmFuc2Zvcm0uX193cmFwcGVkVHJhbnNmb3JtX18pIHtcbiAgICByZXR1cm4gdHJhbnNmb3JtO1xuICB9XG5cbiAgY29uc3Qgd3JhcHBlZCA9IGRvYyA9PiB7XG4gICAgaWYgKCFoYXNPd24uY2FsbChkb2MsICdfaWQnKSkge1xuICAgICAgLy8gWFhYIGRvIHdlIGV2ZXIgaGF2ZSBhIHRyYW5zZm9ybSBvbiB0aGUgb3Bsb2cncyBjb2xsZWN0aW9uPyBiZWNhdXNlIHRoYXRcbiAgICAgIC8vIGNvbGxlY3Rpb24gaGFzIG5vIF9pZC5cbiAgICAgIHRocm93IG5ldyBFcnJvcignY2FuIG9ubHkgdHJhbnNmb3JtIGRvY3VtZW50cyB3aXRoIF9pZCcpO1xuICAgIH1cblxuICAgIGNvbnN0IGlkID0gZG9jLl9pZDtcblxuICAgIC8vIFhYWCBjb25zaWRlciBtYWtpbmcgdHJhY2tlciBhIHdlYWsgZGVwZW5kZW5jeSBhbmQgY2hlY2tpbmdcbiAgICAvLyBQYWNrYWdlLnRyYWNrZXIgaGVyZVxuICAgIGNvbnN0IHRyYW5zZm9ybWVkID0gVHJhY2tlci5ub25yZWFjdGl2ZSgoKSA9PiB0cmFuc2Zvcm0oZG9jKSk7XG5cbiAgICBpZiAoIUxvY2FsQ29sbGVjdGlvbi5faXNQbGFpbk9iamVjdCh0cmFuc2Zvcm1lZCkpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcigndHJhbnNmb3JtIG11c3QgcmV0dXJuIG9iamVjdCcpO1xuICAgIH1cblxuICAgIGlmIChoYXNPd24uY2FsbCh0cmFuc2Zvcm1lZCwgJ19pZCcpKSB7XG4gICAgICBpZiAoIUVKU09OLmVxdWFscyh0cmFuc2Zvcm1lZC5faWQsIGlkKSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RyYW5zZm9ybWVkIGRvY3VtZW50IGNhblxcJ3QgaGF2ZSBkaWZmZXJlbnQgX2lkJyk7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHRyYW5zZm9ybWVkLl9pZCA9IGlkO1xuICAgIH1cblxuICAgIHJldHVybiB0cmFuc2Zvcm1lZDtcbiAgfTtcblxuICB3cmFwcGVkLl9fd3JhcHBlZFRyYW5zZm9ybV9fID0gdHJ1ZTtcblxuICByZXR1cm4gd3JhcHBlZDtcbn07XG5cbi8vIFhYWCB0aGUgc29ydGVkLXF1ZXJ5IGxvZ2ljIGJlbG93IGlzIGxhdWdoYWJseSBpbmVmZmljaWVudC4gd2UnbGxcbi8vIG5lZWQgdG8gY29tZSB1cCB3aXRoIGEgYmV0dGVyIGRhdGFzdHJ1Y3R1cmUgZm9yIHRoaXMuXG4vL1xuLy8gWFhYIHRoZSBsb2dpYyBmb3Igb2JzZXJ2aW5nIHdpdGggYSBza2lwIG9yIGEgbGltaXQgaXMgZXZlbiBtb3JlXG4vLyBsYXVnaGFibHkgaW5lZmZpY2llbnQuIHdlIHJlY29tcHV0ZSB0aGUgd2hvbGUgcmVzdWx0cyBldmVyeSB0aW1lIVxuXG4vLyBUaGlzIGJpbmFyeSBzZWFyY2ggcHV0cyBhIHZhbHVlIGJldHdlZW4gYW55IGVxdWFsIHZhbHVlcywgYW5kIHRoZSBmaXJzdFxuLy8gbGVzc2VyIHZhbHVlLlxuTG9jYWxDb2xsZWN0aW9uLl9iaW5hcnlTZWFyY2ggPSAoY21wLCBhcnJheSwgdmFsdWUpID0+IHtcbiAgbGV0IGZpcnN0ID0gMDtcbiAgbGV0IHJhbmdlID0gYXJyYXkubGVuZ3RoO1xuXG4gIHdoaWxlIChyYW5nZSA+IDApIHtcbiAgICBjb25zdCBoYWxmUmFuZ2UgPSBNYXRoLmZsb29yKHJhbmdlIC8gMik7XG5cbiAgICBpZiAoY21wKHZhbHVlLCBhcnJheVtmaXJzdCArIGhhbGZSYW5nZV0pID49IDApIHtcbiAgICAgIGZpcnN0ICs9IGhhbGZSYW5nZSArIDE7XG4gICAgICByYW5nZSAtPSBoYWxmUmFuZ2UgKyAxO1xuICAgIH0gZWxzZSB7XG4gICAgICByYW5nZSA9IGhhbGZSYW5nZTtcbiAgICB9XG4gIH1cblxuICByZXR1cm4gZmlyc3Q7XG59O1xuXG5Mb2NhbENvbGxlY3Rpb24uX2NoZWNrU3VwcG9ydGVkUHJvamVjdGlvbiA9IGZpZWxkcyA9PiB7XG4gIGlmIChmaWVsZHMgIT09IE9iamVjdChmaWVsZHMpIHx8IEFycmF5LmlzQXJyYXkoZmllbGRzKSkge1xuICAgIHRocm93IE1pbmltb25nb0Vycm9yKCdmaWVsZHMgb3B0aW9uIG11c3QgYmUgYW4gb2JqZWN0Jyk7XG4gIH1cblxuICBPYmplY3Qua2V5cyhmaWVsZHMpLmZvckVhY2goa2V5UGF0aCA9PiB7XG4gICAgaWYgKGtleVBhdGguc3BsaXQoJy4nKS5pbmNsdWRlcygnJCcpKSB7XG4gICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcihcbiAgICAgICAgJ01pbmltb25nbyBkb2VzblxcJ3Qgc3VwcG9ydCAkIG9wZXJhdG9yIGluIHByb2plY3Rpb25zIHlldC4nXG4gICAgICApO1xuICAgIH1cblxuICAgIGNvbnN0IHZhbHVlID0gZmllbGRzW2tleVBhdGhdO1xuXG4gICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ29iamVjdCcgJiZcbiAgICAgICAgWyckZWxlbU1hdGNoJywgJyRtZXRhJywgJyRzbGljZSddLnNvbWUoa2V5ID0+XG4gICAgICAgICAgaGFzT3duLmNhbGwodmFsdWUsIGtleSlcbiAgICAgICAgKSkge1xuICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoXG4gICAgICAgICdNaW5pbW9uZ28gZG9lc25cXCd0IHN1cHBvcnQgb3BlcmF0b3JzIGluIHByb2plY3Rpb25zIHlldC4nXG4gICAgICApO1xuICAgIH1cblxuICAgIGlmICghWzEsIDAsIHRydWUsIGZhbHNlXS5pbmNsdWRlcyh2YWx1ZSkpIHtcbiAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKFxuICAgICAgICAnUHJvamVjdGlvbiB2YWx1ZXMgc2hvdWxkIGJlIG9uZSBvZiAxLCAwLCB0cnVlLCBvciBmYWxzZSdcbiAgICAgICk7XG4gICAgfVxuICB9KTtcbn07XG5cbi8vIEtub3dzIGhvdyB0byBjb21waWxlIGEgZmllbGRzIHByb2plY3Rpb24gdG8gYSBwcmVkaWNhdGUgZnVuY3Rpb24uXG4vLyBAcmV0dXJucyAtIEZ1bmN0aW9uOiBhIGNsb3N1cmUgdGhhdCBmaWx0ZXJzIG91dCBhbiBvYmplY3QgYWNjb3JkaW5nIHRvIHRoZVxuLy8gICAgICAgICAgICBmaWVsZHMgcHJvamVjdGlvbiBydWxlczpcbi8vICAgICAgICAgICAgQHBhcmFtIG9iaiAtIE9iamVjdDogTW9uZ29EQi1zdHlsZWQgZG9jdW1lbnRcbi8vICAgICAgICAgICAgQHJldHVybnMgLSBPYmplY3Q6IGEgZG9jdW1lbnQgd2l0aCB0aGUgZmllbGRzIGZpbHRlcmVkIG91dFxuLy8gICAgICAgICAgICAgICAgICAgICAgIGFjY29yZGluZyB0byBwcm9qZWN0aW9uIHJ1bGVzLiBEb2Vzbid0IHJldGFpbiBzdWJmaWVsZHNcbi8vICAgICAgICAgICAgICAgICAgICAgICBvZiBwYXNzZWQgYXJndW1lbnQuXG5Mb2NhbENvbGxlY3Rpb24uX2NvbXBpbGVQcm9qZWN0aW9uID0gZmllbGRzID0+IHtcbiAgTG9jYWxDb2xsZWN0aW9uLl9jaGVja1N1cHBvcnRlZFByb2plY3Rpb24oZmllbGRzKTtcblxuICBjb25zdCBfaWRQcm9qZWN0aW9uID0gZmllbGRzLl9pZCA9PT0gdW5kZWZpbmVkID8gdHJ1ZSA6IGZpZWxkcy5faWQ7XG4gIGNvbnN0IGRldGFpbHMgPSBwcm9qZWN0aW9uRGV0YWlscyhmaWVsZHMpO1xuXG4gIC8vIHJldHVybnMgdHJhbnNmb3JtZWQgZG9jIGFjY29yZGluZyB0byBydWxlVHJlZVxuICBjb25zdCB0cmFuc2Zvcm0gPSAoZG9jLCBydWxlVHJlZSkgPT4ge1xuICAgIC8vIFNwZWNpYWwgY2FzZSBmb3IgXCJzZXRzXCJcbiAgICBpZiAoQXJyYXkuaXNBcnJheShkb2MpKSB7XG4gICAgICByZXR1cm4gZG9jLm1hcChzdWJkb2MgPT4gdHJhbnNmb3JtKHN1YmRvYywgcnVsZVRyZWUpKTtcbiAgICB9XG5cbiAgICBjb25zdCByZXN1bHQgPSBkZXRhaWxzLmluY2x1ZGluZyA/IHt9IDogRUpTT04uY2xvbmUoZG9jKTtcblxuICAgIE9iamVjdC5rZXlzKHJ1bGVUcmVlKS5mb3JFYWNoKGtleSA9PiB7XG4gICAgICBpZiAoZG9jID09IG51bGwgfHwgIWhhc093bi5jYWxsKGRvYywga2V5KSkge1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHJ1bGUgPSBydWxlVHJlZVtrZXldO1xuXG4gICAgICBpZiAocnVsZSA9PT0gT2JqZWN0KHJ1bGUpKSB7XG4gICAgICAgIC8vIEZvciBzdWItb2JqZWN0cy9zdWJzZXRzIHdlIGJyYW5jaFxuICAgICAgICBpZiAoZG9jW2tleV0gPT09IE9iamVjdChkb2Nba2V5XSkpIHtcbiAgICAgICAgICByZXN1bHRba2V5XSA9IHRyYW5zZm9ybShkb2Nba2V5XSwgcnVsZSk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSBpZiAoZGV0YWlscy5pbmNsdWRpbmcpIHtcbiAgICAgICAgLy8gT3RoZXJ3aXNlIHdlIGRvbid0IGV2ZW4gdG91Y2ggdGhpcyBzdWJmaWVsZFxuICAgICAgICByZXN1bHRba2V5XSA9IEVKU09OLmNsb25lKGRvY1trZXldKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGRlbGV0ZSByZXN1bHRba2V5XTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIHJldHVybiBkb2MgIT0gbnVsbCA/IHJlc3VsdCA6IGRvYztcbiAgfTtcblxuICByZXR1cm4gZG9jID0+IHtcbiAgICBjb25zdCByZXN1bHQgPSB0cmFuc2Zvcm0oZG9jLCBkZXRhaWxzLnRyZWUpO1xuXG4gICAgaWYgKF9pZFByb2plY3Rpb24gJiYgaGFzT3duLmNhbGwoZG9jLCAnX2lkJykpIHtcbiAgICAgIHJlc3VsdC5faWQgPSBkb2MuX2lkO1xuICAgIH1cblxuICAgIGlmICghX2lkUHJvamVjdGlvbiAmJiBoYXNPd24uY2FsbChyZXN1bHQsICdfaWQnKSkge1xuICAgICAgZGVsZXRlIHJlc3VsdC5faWQ7XG4gICAgfVxuXG4gICAgcmV0dXJuIHJlc3VsdDtcbiAgfTtcbn07XG5cbi8vIENhbGN1bGF0ZXMgdGhlIGRvY3VtZW50IHRvIGluc2VydCBpbiBjYXNlIHdlJ3JlIGRvaW5nIGFuIHVwc2VydCBhbmQgdGhlXG4vLyBzZWxlY3RvciBkb2VzIG5vdCBtYXRjaCBhbnkgZWxlbWVudHNcbkxvY2FsQ29sbGVjdGlvbi5fY3JlYXRlVXBzZXJ0RG9jdW1lbnQgPSAoc2VsZWN0b3IsIG1vZGlmaWVyKSA9PiB7XG4gIGNvbnN0IHNlbGVjdG9yRG9jdW1lbnQgPSBwb3B1bGF0ZURvY3VtZW50V2l0aFF1ZXJ5RmllbGRzKHNlbGVjdG9yKTtcbiAgY29uc3QgaXNNb2RpZnkgPSBMb2NhbENvbGxlY3Rpb24uX2lzTW9kaWZpY2F0aW9uTW9kKG1vZGlmaWVyKTtcblxuICBjb25zdCBuZXdEb2MgPSB7fTtcblxuICBpZiAoc2VsZWN0b3JEb2N1bWVudC5faWQpIHtcbiAgICBuZXdEb2MuX2lkID0gc2VsZWN0b3JEb2N1bWVudC5faWQ7XG4gICAgZGVsZXRlIHNlbGVjdG9yRG9jdW1lbnQuX2lkO1xuICB9XG5cbiAgLy8gVGhpcyBkb3VibGUgX21vZGlmeSBjYWxsIGlzIG1hZGUgdG8gaGVscCB3aXRoIG5lc3RlZCBwcm9wZXJ0aWVzIChzZWUgaXNzdWVcbiAgLy8gIzg2MzEpLiBXZSBkbyB0aGlzIGV2ZW4gaWYgaXQncyBhIHJlcGxhY2VtZW50IGZvciB2YWxpZGF0aW9uIHB1cnBvc2VzIChlLmcuXG4gIC8vIGFtYmlndW91cyBpZCdzKVxuICBMb2NhbENvbGxlY3Rpb24uX21vZGlmeShuZXdEb2MsIHskc2V0OiBzZWxlY3RvckRvY3VtZW50fSk7XG4gIExvY2FsQ29sbGVjdGlvbi5fbW9kaWZ5KG5ld0RvYywgbW9kaWZpZXIsIHtpc0luc2VydDogdHJ1ZX0pO1xuXG4gIGlmIChpc01vZGlmeSkge1xuICAgIHJldHVybiBuZXdEb2M7XG4gIH1cblxuICAvLyBSZXBsYWNlbWVudCBjYW4gdGFrZSBfaWQgZnJvbSBxdWVyeSBkb2N1bWVudFxuICBjb25zdCByZXBsYWNlbWVudCA9IE9iamVjdC5hc3NpZ24oe30sIG1vZGlmaWVyKTtcbiAgaWYgKG5ld0RvYy5faWQpIHtcbiAgICByZXBsYWNlbWVudC5faWQgPSBuZXdEb2MuX2lkO1xuICB9XG5cbiAgcmV0dXJuIHJlcGxhY2VtZW50O1xufTtcblxuTG9jYWxDb2xsZWN0aW9uLl9kaWZmT2JqZWN0cyA9IChsZWZ0LCByaWdodCwgY2FsbGJhY2tzKSA9PiB7XG4gIHJldHVybiBEaWZmU2VxdWVuY2UuZGlmZk9iamVjdHMobGVmdCwgcmlnaHQsIGNhbGxiYWNrcyk7XG59O1xuXG4vLyBvcmRlcmVkOiBib29sLlxuLy8gb2xkX3Jlc3VsdHMgYW5kIG5ld19yZXN1bHRzOiBjb2xsZWN0aW9ucyBvZiBkb2N1bWVudHMuXG4vLyAgICBpZiBvcmRlcmVkLCB0aGV5IGFyZSBhcnJheXMuXG4vLyAgICBpZiB1bm9yZGVyZWQsIHRoZXkgYXJlIElkTWFwc1xuTG9jYWxDb2xsZWN0aW9uLl9kaWZmUXVlcnlDaGFuZ2VzID0gKG9yZGVyZWQsIG9sZFJlc3VsdHMsIG5ld1Jlc3VsdHMsIG9ic2VydmVyLCBvcHRpb25zKSA9PlxuICBEaWZmU2VxdWVuY2UuZGlmZlF1ZXJ5Q2hhbmdlcyhvcmRlcmVkLCBvbGRSZXN1bHRzLCBuZXdSZXN1bHRzLCBvYnNlcnZlciwgb3B0aW9ucylcbjtcblxuTG9jYWxDb2xsZWN0aW9uLl9kaWZmUXVlcnlPcmRlcmVkQ2hhbmdlcyA9IChvbGRSZXN1bHRzLCBuZXdSZXN1bHRzLCBvYnNlcnZlciwgb3B0aW9ucykgPT5cbiAgRGlmZlNlcXVlbmNlLmRpZmZRdWVyeU9yZGVyZWRDaGFuZ2VzKG9sZFJlc3VsdHMsIG5ld1Jlc3VsdHMsIG9ic2VydmVyLCBvcHRpb25zKVxuO1xuXG5Mb2NhbENvbGxlY3Rpb24uX2RpZmZRdWVyeVVub3JkZXJlZENoYW5nZXMgPSAob2xkUmVzdWx0cywgbmV3UmVzdWx0cywgb2JzZXJ2ZXIsIG9wdGlvbnMpID0+XG4gIERpZmZTZXF1ZW5jZS5kaWZmUXVlcnlVbm9yZGVyZWRDaGFuZ2VzKG9sZFJlc3VsdHMsIG5ld1Jlc3VsdHMsIG9ic2VydmVyLCBvcHRpb25zKVxuO1xuXG5Mb2NhbENvbGxlY3Rpb24uX2ZpbmRJbk9yZGVyZWRSZXN1bHRzID0gKHF1ZXJ5LCBkb2MpID0+IHtcbiAgaWYgKCFxdWVyeS5vcmRlcmVkKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdDYW5cXCd0IGNhbGwgX2ZpbmRJbk9yZGVyZWRSZXN1bHRzIG9uIHVub3JkZXJlZCBxdWVyeScpO1xuICB9XG5cbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBxdWVyeS5yZXN1bHRzLmxlbmd0aDsgaSsrKSB7XG4gICAgaWYgKHF1ZXJ5LnJlc3VsdHNbaV0gPT09IGRvYykge1xuICAgICAgcmV0dXJuIGk7XG4gICAgfVxuICB9XG5cbiAgdGhyb3cgRXJyb3IoJ29iamVjdCBtaXNzaW5nIGZyb20gcXVlcnknKTtcbn07XG5cbi8vIElmIHRoaXMgaXMgYSBzZWxlY3RvciB3aGljaCBleHBsaWNpdGx5IGNvbnN0cmFpbnMgdGhlIG1hdGNoIGJ5IElEIHRvIGEgZmluaXRlXG4vLyBudW1iZXIgb2YgZG9jdW1lbnRzLCByZXR1cm5zIGEgbGlzdCBvZiB0aGVpciBJRHMuICBPdGhlcndpc2UgcmV0dXJuc1xuLy8gbnVsbC4gTm90ZSB0aGF0IHRoZSBzZWxlY3RvciBtYXkgaGF2ZSBvdGhlciByZXN0cmljdGlvbnMgc28gaXQgbWF5IG5vdCBldmVuXG4vLyBtYXRjaCB0aG9zZSBkb2N1bWVudCEgIFdlIGNhcmUgYWJvdXQgJGluIGFuZCAkYW5kIHNpbmNlIHRob3NlIGFyZSBnZW5lcmF0ZWRcbi8vIGFjY2Vzcy1jb250cm9sbGVkIHVwZGF0ZSBhbmQgcmVtb3ZlLlxuTG9jYWxDb2xsZWN0aW9uLl9pZHNNYXRjaGVkQnlTZWxlY3RvciA9IHNlbGVjdG9yID0+IHtcbiAgLy8gSXMgdGhlIHNlbGVjdG9yIGp1c3QgYW4gSUQ/XG4gIGlmIChMb2NhbENvbGxlY3Rpb24uX3NlbGVjdG9ySXNJZChzZWxlY3RvcikpIHtcbiAgICByZXR1cm4gW3NlbGVjdG9yXTtcbiAgfVxuXG4gIGlmICghc2VsZWN0b3IpIHtcbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIC8vIERvIHdlIGhhdmUgYW4gX2lkIGNsYXVzZT9cbiAgaWYgKGhhc093bi5jYWxsKHNlbGVjdG9yLCAnX2lkJykpIHtcbiAgICAvLyBJcyB0aGUgX2lkIGNsYXVzZSBqdXN0IGFuIElEP1xuICAgIGlmIChMb2NhbENvbGxlY3Rpb24uX3NlbGVjdG9ySXNJZChzZWxlY3Rvci5faWQpKSB7XG4gICAgICByZXR1cm4gW3NlbGVjdG9yLl9pZF07XG4gICAgfVxuXG4gICAgLy8gSXMgdGhlIF9pZCBjbGF1c2Uge19pZDogeyRpbjogW1wieFwiLCBcInlcIiwgXCJ6XCJdfX0/XG4gICAgaWYgKHNlbGVjdG9yLl9pZFxuICAgICAgICAmJiBBcnJheS5pc0FycmF5KHNlbGVjdG9yLl9pZC4kaW4pXG4gICAgICAgICYmIHNlbGVjdG9yLl9pZC4kaW4ubGVuZ3RoXG4gICAgICAgICYmIHNlbGVjdG9yLl9pZC4kaW4uZXZlcnkoTG9jYWxDb2xsZWN0aW9uLl9zZWxlY3RvcklzSWQpKSB7XG4gICAgICByZXR1cm4gc2VsZWN0b3IuX2lkLiRpbjtcbiAgICB9XG5cbiAgICByZXR1cm4gbnVsbDtcbiAgfVxuXG4gIC8vIElmIHRoaXMgaXMgYSB0b3AtbGV2ZWwgJGFuZCwgYW5kIGFueSBvZiB0aGUgY2xhdXNlcyBjb25zdHJhaW4gdGhlaXJcbiAgLy8gZG9jdW1lbnRzLCB0aGVuIHRoZSB3aG9sZSBzZWxlY3RvciBpcyBjb25zdHJhaW5lZCBieSBhbnkgb25lIGNsYXVzZSdzXG4gIC8vIGNvbnN0cmFpbnQuIChXZWxsLCBieSB0aGVpciBpbnRlcnNlY3Rpb24sIGJ1dCB0aGF0IHNlZW1zIHVubGlrZWx5LilcbiAgaWYgKEFycmF5LmlzQXJyYXkoc2VsZWN0b3IuJGFuZCkpIHtcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IHNlbGVjdG9yLiRhbmQubGVuZ3RoOyArK2kpIHtcbiAgICAgIGNvbnN0IHN1YklkcyA9IExvY2FsQ29sbGVjdGlvbi5faWRzTWF0Y2hlZEJ5U2VsZWN0b3Ioc2VsZWN0b3IuJGFuZFtpXSk7XG5cbiAgICAgIGlmIChzdWJJZHMpIHtcbiAgICAgICAgcmV0dXJuIHN1YklkcztcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZXR1cm4gbnVsbDtcbn07XG5cbkxvY2FsQ29sbGVjdGlvbi5faW5zZXJ0SW5SZXN1bHRzID0gKHF1ZXJ5LCBkb2MpID0+IHtcbiAgY29uc3QgZmllbGRzID0gRUpTT04uY2xvbmUoZG9jKTtcblxuICBkZWxldGUgZmllbGRzLl9pZDtcblxuICBpZiAocXVlcnkub3JkZXJlZCkge1xuICAgIGlmICghcXVlcnkuc29ydGVyKSB7XG4gICAgICBxdWVyeS5hZGRlZEJlZm9yZShkb2MuX2lkLCBxdWVyeS5wcm9qZWN0aW9uRm4oZmllbGRzKSwgbnVsbCk7XG4gICAgICBxdWVyeS5yZXN1bHRzLnB1c2goZG9jKTtcbiAgICB9IGVsc2Uge1xuICAgICAgY29uc3QgaSA9IExvY2FsQ29sbGVjdGlvbi5faW5zZXJ0SW5Tb3J0ZWRMaXN0KFxuICAgICAgICBxdWVyeS5zb3J0ZXIuZ2V0Q29tcGFyYXRvcih7ZGlzdGFuY2VzOiBxdWVyeS5kaXN0YW5jZXN9KSxcbiAgICAgICAgcXVlcnkucmVzdWx0cyxcbiAgICAgICAgZG9jXG4gICAgICApO1xuXG4gICAgICBsZXQgbmV4dCA9IHF1ZXJ5LnJlc3VsdHNbaSArIDFdO1xuICAgICAgaWYgKG5leHQpIHtcbiAgICAgICAgbmV4dCA9IG5leHQuX2lkO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgbmV4dCA9IG51bGw7XG4gICAgICB9XG5cbiAgICAgIHF1ZXJ5LmFkZGVkQmVmb3JlKGRvYy5faWQsIHF1ZXJ5LnByb2plY3Rpb25GbihmaWVsZHMpLCBuZXh0KTtcbiAgICB9XG5cbiAgICBxdWVyeS5hZGRlZChkb2MuX2lkLCBxdWVyeS5wcm9qZWN0aW9uRm4oZmllbGRzKSk7XG4gIH0gZWxzZSB7XG4gICAgcXVlcnkuYWRkZWQoZG9jLl9pZCwgcXVlcnkucHJvamVjdGlvbkZuKGZpZWxkcykpO1xuICAgIHF1ZXJ5LnJlc3VsdHMuc2V0KGRvYy5faWQsIGRvYyk7XG4gIH1cbn07XG5cbkxvY2FsQ29sbGVjdGlvbi5faW5zZXJ0SW5Tb3J0ZWRMaXN0ID0gKGNtcCwgYXJyYXksIHZhbHVlKSA9PiB7XG4gIGlmIChhcnJheS5sZW5ndGggPT09IDApIHtcbiAgICBhcnJheS5wdXNoKHZhbHVlKTtcbiAgICByZXR1cm4gMDtcbiAgfVxuXG4gIGNvbnN0IGkgPSBMb2NhbENvbGxlY3Rpb24uX2JpbmFyeVNlYXJjaChjbXAsIGFycmF5LCB2YWx1ZSk7XG5cbiAgYXJyYXkuc3BsaWNlKGksIDAsIHZhbHVlKTtcblxuICByZXR1cm4gaTtcbn07XG5cbkxvY2FsQ29sbGVjdGlvbi5faXNNb2RpZmljYXRpb25Nb2QgPSBtb2QgPT4ge1xuICBsZXQgaXNNb2RpZnkgPSBmYWxzZTtcbiAgbGV0IGlzUmVwbGFjZSA9IGZhbHNlO1xuXG4gIE9iamVjdC5rZXlzKG1vZCkuZm9yRWFjaChrZXkgPT4ge1xuICAgIGlmIChrZXkuc3Vic3RyKDAsIDEpID09PSAnJCcpIHtcbiAgICAgIGlzTW9kaWZ5ID0gdHJ1ZTtcbiAgICB9IGVsc2Uge1xuICAgICAgaXNSZXBsYWNlID0gdHJ1ZTtcbiAgICB9XG4gIH0pO1xuXG4gIGlmIChpc01vZGlmeSAmJiBpc1JlcGxhY2UpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICAnVXBkYXRlIHBhcmFtZXRlciBjYW5ub3QgaGF2ZSBib3RoIG1vZGlmaWVyIGFuZCBub24tbW9kaWZpZXIgZmllbGRzLidcbiAgICApO1xuICB9XG5cbiAgcmV0dXJuIGlzTW9kaWZ5O1xufTtcblxuLy8gWFhYIG1heWJlIHRoaXMgc2hvdWxkIGJlIEVKU09OLmlzT2JqZWN0LCB0aG91Z2ggRUpTT04gZG9lc24ndCBrbm93IGFib3V0XG4vLyBSZWdFeHBcbi8vIFhYWCBub3RlIHRoYXQgX3R5cGUodW5kZWZpbmVkKSA9PT0gMyEhISFcbkxvY2FsQ29sbGVjdGlvbi5faXNQbGFpbk9iamVjdCA9IHggPT4ge1xuICByZXR1cm4geCAmJiBMb2NhbENvbGxlY3Rpb24uX2YuX3R5cGUoeCkgPT09IDM7XG59O1xuXG4vLyBYWFggbmVlZCBhIHN0cmF0ZWd5IGZvciBwYXNzaW5nIHRoZSBiaW5kaW5nIG9mICQgaW50byB0aGlzXG4vLyBmdW5jdGlvbiwgZnJvbSB0aGUgY29tcGlsZWQgc2VsZWN0b3Jcbi8vXG4vLyBtYXliZSBqdXN0IHtrZXkudXAudG8uanVzdC5iZWZvcmUuZG9sbGFyc2lnbjogYXJyYXlfaW5kZXh9XG4vL1xuLy8gWFhYIGF0b21pY2l0eTogaWYgb25lIG1vZGlmaWNhdGlvbiBmYWlscywgZG8gd2Ugcm9sbCBiYWNrIHRoZSB3aG9sZVxuLy8gY2hhbmdlP1xuLy9cbi8vIG9wdGlvbnM6XG4vLyAgIC0gaXNJbnNlcnQgaXMgc2V0IHdoZW4gX21vZGlmeSBpcyBiZWluZyBjYWxsZWQgdG8gY29tcHV0ZSB0aGUgZG9jdW1lbnQgdG9cbi8vICAgICBpbnNlcnQgYXMgcGFydCBvZiBhbiB1cHNlcnQgb3BlcmF0aW9uLiBXZSB1c2UgdGhpcyBwcmltYXJpbHkgdG8gZmlndXJlXG4vLyAgICAgb3V0IHdoZW4gdG8gc2V0IHRoZSBmaWVsZHMgaW4gJHNldE9uSW5zZXJ0LCBpZiBwcmVzZW50LlxuTG9jYWxDb2xsZWN0aW9uLl9tb2RpZnkgPSAoZG9jLCBtb2RpZmllciwgb3B0aW9ucyA9IHt9KSA9PiB7XG4gIGlmICghTG9jYWxDb2xsZWN0aW9uLl9pc1BsYWluT2JqZWN0KG1vZGlmaWVyKSkge1xuICAgIHRocm93IE1pbmltb25nb0Vycm9yKCdNb2RpZmllciBtdXN0IGJlIGFuIG9iamVjdCcpO1xuICB9XG5cbiAgLy8gTWFrZSBzdXJlIHRoZSBjYWxsZXIgY2FuJ3QgbXV0YXRlIG91ciBkYXRhIHN0cnVjdHVyZXMuXG4gIG1vZGlmaWVyID0gRUpTT04uY2xvbmUobW9kaWZpZXIpO1xuXG4gIGNvbnN0IGlzTW9kaWZpZXIgPSBpc09wZXJhdG9yT2JqZWN0KG1vZGlmaWVyKTtcbiAgY29uc3QgbmV3RG9jID0gaXNNb2RpZmllciA/IEVKU09OLmNsb25lKGRvYykgOiBtb2RpZmllcjtcblxuICBpZiAoaXNNb2RpZmllcikge1xuICAgIC8vIGFwcGx5IG1vZGlmaWVycyB0byB0aGUgZG9jLlxuICAgIE9iamVjdC5rZXlzKG1vZGlmaWVyKS5mb3JFYWNoKG9wZXJhdG9yID0+IHtcbiAgICAgIC8vIFRyZWF0ICRzZXRPbkluc2VydCBhcyAkc2V0IGlmIHRoaXMgaXMgYW4gaW5zZXJ0LlxuICAgICAgY29uc3Qgc2V0T25JbnNlcnQgPSBvcHRpb25zLmlzSW5zZXJ0ICYmIG9wZXJhdG9yID09PSAnJHNldE9uSW5zZXJ0JztcbiAgICAgIGNvbnN0IG1vZEZ1bmMgPSBNT0RJRklFUlNbc2V0T25JbnNlcnQgPyAnJHNldCcgOiBvcGVyYXRvcl07XG4gICAgICBjb25zdCBvcGVyYW5kID0gbW9kaWZpZXJbb3BlcmF0b3JdO1xuXG4gICAgICBpZiAoIW1vZEZ1bmMpIHtcbiAgICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoYEludmFsaWQgbW9kaWZpZXIgc3BlY2lmaWVkICR7b3BlcmF0b3J9YCk7XG4gICAgICB9XG5cbiAgICAgIE9iamVjdC5rZXlzKG9wZXJhbmQpLmZvckVhY2goa2V5cGF0aCA9PiB7XG4gICAgICAgIGNvbnN0IGFyZyA9IG9wZXJhbmRba2V5cGF0aF07XG5cbiAgICAgICAgaWYgKGtleXBhdGggPT09ICcnKSB7XG4gICAgICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoJ0FuIGVtcHR5IHVwZGF0ZSBwYXRoIGlzIG5vdCB2YWxpZC4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IGtleXBhcnRzID0ga2V5cGF0aC5zcGxpdCgnLicpO1xuXG4gICAgICAgIGlmICgha2V5cGFydHMuZXZlcnkoQm9vbGVhbikpIHtcbiAgICAgICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcihcbiAgICAgICAgICAgIGBUaGUgdXBkYXRlIHBhdGggJyR7a2V5cGF0aH0nIGNvbnRhaW5zIGFuIGVtcHR5IGZpZWxkIG5hbWUsIGAgK1xuICAgICAgICAgICAgJ3doaWNoIGlzIG5vdCBhbGxvd2VkLidcbiAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgdGFyZ2V0ID0gZmluZE1vZFRhcmdldChuZXdEb2MsIGtleXBhcnRzLCB7XG4gICAgICAgICAgYXJyYXlJbmRpY2VzOiBvcHRpb25zLmFycmF5SW5kaWNlcyxcbiAgICAgICAgICBmb3JiaWRBcnJheTogb3BlcmF0b3IgPT09ICckcmVuYW1lJyxcbiAgICAgICAgICBub0NyZWF0ZTogTk9fQ1JFQVRFX01PRElGSUVSU1tvcGVyYXRvcl1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgbW9kRnVuYyh0YXJnZXQsIGtleXBhcnRzLnBvcCgpLCBhcmcsIGtleXBhdGgsIG5ld0RvYyk7XG4gICAgICB9KTtcbiAgICB9KTtcblxuICAgIGlmIChkb2MuX2lkICYmICFFSlNPTi5lcXVhbHMoZG9jLl9pZCwgbmV3RG9jLl9pZCkpIHtcbiAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKFxuICAgICAgICBgQWZ0ZXIgYXBwbHlpbmcgdGhlIHVwZGF0ZSB0byB0aGUgZG9jdW1lbnQge19pZDogXCIke2RvYy5faWR9XCIsIC4uLn0sYCArXG4gICAgICAgICcgdGhlIChpbW11dGFibGUpIGZpZWxkIFxcJ19pZFxcJyB3YXMgZm91bmQgdG8gaGF2ZSBiZWVuIGFsdGVyZWQgdG8gJyArXG4gICAgICAgIGBfaWQ6IFwiJHtuZXdEb2MuX2lkfVwiYFxuICAgICAgKTtcbiAgICB9XG4gIH0gZWxzZSB7XG4gICAgaWYgKGRvYy5faWQgJiYgbW9kaWZpZXIuX2lkICYmICFFSlNPTi5lcXVhbHMoZG9jLl9pZCwgbW9kaWZpZXIuX2lkKSkge1xuICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoXG4gICAgICAgIGBUaGUgX2lkIGZpZWxkIGNhbm5vdCBiZSBjaGFuZ2VkIGZyb20ge19pZDogXCIke2RvYy5faWR9XCJ9IHRvIGAgK1xuICAgICAgICBge19pZDogXCIke21vZGlmaWVyLl9pZH1cIn1gXG4gICAgICApO1xuICAgIH1cblxuICAgIC8vIHJlcGxhY2UgdGhlIHdob2xlIGRvY3VtZW50XG4gICAgYXNzZXJ0SGFzVmFsaWRGaWVsZE5hbWVzKG1vZGlmaWVyKTtcbiAgfVxuXG4gIC8vIG1vdmUgbmV3IGRvY3VtZW50IGludG8gcGxhY2UuXG4gIE9iamVjdC5rZXlzKGRvYykuZm9yRWFjaChrZXkgPT4ge1xuICAgIC8vIE5vdGU6IHRoaXMgdXNlZCB0byBiZSBmb3IgKHZhciBrZXkgaW4gZG9jKSBob3dldmVyLCB0aGlzIGRvZXMgbm90XG4gICAgLy8gd29yayByaWdodCBpbiBPcGVyYS4gRGVsZXRpbmcgZnJvbSBhIGRvYyB3aGlsZSBpdGVyYXRpbmcgb3ZlciBpdFxuICAgIC8vIHdvdWxkIHNvbWV0aW1lcyBjYXVzZSBvcGVyYSB0byBza2lwIHNvbWUga2V5cy5cbiAgICBpZiAoa2V5ICE9PSAnX2lkJykge1xuICAgICAgZGVsZXRlIGRvY1trZXldO1xuICAgIH1cbiAgfSk7XG5cbiAgT2JqZWN0LmtleXMobmV3RG9jKS5mb3JFYWNoKGtleSA9PiB7XG4gICAgZG9jW2tleV0gPSBuZXdEb2Nba2V5XTtcbiAgfSk7XG59O1xuXG5Mb2NhbENvbGxlY3Rpb24uX29ic2VydmVGcm9tT2JzZXJ2ZUNoYW5nZXMgPSAoY3Vyc29yLCBvYnNlcnZlQ2FsbGJhY2tzKSA9PiB7XG4gIGNvbnN0IHRyYW5zZm9ybSA9IGN1cnNvci5nZXRUcmFuc2Zvcm0oKSB8fCAoZG9jID0+IGRvYyk7XG4gIGxldCBzdXBwcmVzc2VkID0gISFvYnNlcnZlQ2FsbGJhY2tzLl9zdXBwcmVzc19pbml0aWFsO1xuXG4gIGxldCBvYnNlcnZlQ2hhbmdlc0NhbGxiYWNrcztcbiAgaWYgKExvY2FsQ29sbGVjdGlvbi5fb2JzZXJ2ZUNhbGxiYWNrc0FyZU9yZGVyZWQob2JzZXJ2ZUNhbGxiYWNrcykpIHtcbiAgICAvLyBUaGUgXCJfbm9faW5kaWNlc1wiIG9wdGlvbiBzZXRzIGFsbCBpbmRleCBhcmd1bWVudHMgdG8gLTEgYW5kIHNraXBzIHRoZVxuICAgIC8vIGxpbmVhciBzY2FucyByZXF1aXJlZCB0byBnZW5lcmF0ZSB0aGVtLiAgVGhpcyBsZXRzIG9ic2VydmVycyB0aGF0IGRvbid0XG4gICAgLy8gbmVlZCBhYnNvbHV0ZSBpbmRpY2VzIGJlbmVmaXQgZnJvbSB0aGUgb3RoZXIgZmVhdHVyZXMgb2YgdGhpcyBBUEkgLS1cbiAgICAvLyByZWxhdGl2ZSBvcmRlciwgdHJhbnNmb3JtcywgYW5kIGFwcGx5Q2hhbmdlcyAtLSB3aXRob3V0IHRoZSBzcGVlZCBoaXQuXG4gICAgY29uc3QgaW5kaWNlcyA9ICFvYnNlcnZlQ2FsbGJhY2tzLl9ub19pbmRpY2VzO1xuXG4gICAgb2JzZXJ2ZUNoYW5nZXNDYWxsYmFja3MgPSB7XG4gICAgICBhZGRlZEJlZm9yZShpZCwgZmllbGRzLCBiZWZvcmUpIHtcbiAgICAgICAgaWYgKHN1cHByZXNzZWQgfHwgIShvYnNlcnZlQ2FsbGJhY2tzLmFkZGVkQXQgfHwgb2JzZXJ2ZUNhbGxiYWNrcy5hZGRlZCkpIHtcbiAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBkb2MgPSB0cmFuc2Zvcm0oT2JqZWN0LmFzc2lnbihmaWVsZHMsIHtfaWQ6IGlkfSkpO1xuXG4gICAgICAgIGlmIChvYnNlcnZlQ2FsbGJhY2tzLmFkZGVkQXQpIHtcbiAgICAgICAgICBvYnNlcnZlQ2FsbGJhY2tzLmFkZGVkQXQoXG4gICAgICAgICAgICBkb2MsXG4gICAgICAgICAgICBpbmRpY2VzXG4gICAgICAgICAgICAgID8gYmVmb3JlXG4gICAgICAgICAgICAgICAgPyB0aGlzLmRvY3MuaW5kZXhPZihiZWZvcmUpXG4gICAgICAgICAgICAgICAgOiB0aGlzLmRvY3Muc2l6ZSgpXG4gICAgICAgICAgICAgIDogLTEsXG4gICAgICAgICAgICBiZWZvcmVcbiAgICAgICAgICApO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIG9ic2VydmVDYWxsYmFja3MuYWRkZWQoZG9jKTtcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICAgIGNoYW5nZWQoaWQsIGZpZWxkcykge1xuICAgICAgICBpZiAoIShvYnNlcnZlQ2FsbGJhY2tzLmNoYW5nZWRBdCB8fCBvYnNlcnZlQ2FsbGJhY2tzLmNoYW5nZWQpKSB7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGRvYyA9IEVKU09OLmNsb25lKHRoaXMuZG9jcy5nZXQoaWQpKTtcbiAgICAgICAgaWYgKCFkb2MpIHtcbiAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFVua25vd24gaWQgZm9yIGNoYW5nZWQ6ICR7aWR9YCk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zdCBvbGREb2MgPSB0cmFuc2Zvcm0oRUpTT04uY2xvbmUoZG9jKSk7XG5cbiAgICAgICAgRGlmZlNlcXVlbmNlLmFwcGx5Q2hhbmdlcyhkb2MsIGZpZWxkcyk7XG5cbiAgICAgICAgaWYgKG9ic2VydmVDYWxsYmFja3MuY2hhbmdlZEF0KSB7XG4gICAgICAgICAgb2JzZXJ2ZUNhbGxiYWNrcy5jaGFuZ2VkQXQoXG4gICAgICAgICAgICB0cmFuc2Zvcm0oZG9jKSxcbiAgICAgICAgICAgIG9sZERvYyxcbiAgICAgICAgICAgIGluZGljZXMgPyB0aGlzLmRvY3MuaW5kZXhPZihpZCkgOiAtMVxuICAgICAgICAgICk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgb2JzZXJ2ZUNhbGxiYWNrcy5jaGFuZ2VkKHRyYW5zZm9ybShkb2MpLCBvbGREb2MpO1xuICAgICAgICB9XG4gICAgICB9LFxuICAgICAgbW92ZWRCZWZvcmUoaWQsIGJlZm9yZSkge1xuICAgICAgICBpZiAoIW9ic2VydmVDYWxsYmFja3MubW92ZWRUbykge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnN0IGZyb20gPSBpbmRpY2VzID8gdGhpcy5kb2NzLmluZGV4T2YoaWQpIDogLTE7XG4gICAgICAgIGxldCB0byA9IGluZGljZXNcbiAgICAgICAgICA/IGJlZm9yZVxuICAgICAgICAgICAgPyB0aGlzLmRvY3MuaW5kZXhPZihiZWZvcmUpXG4gICAgICAgICAgICA6IHRoaXMuZG9jcy5zaXplKClcbiAgICAgICAgICA6IC0xO1xuXG4gICAgICAgIC8vIFdoZW4gbm90IG1vdmluZyBiYWNrd2FyZHMsIGFkanVzdCBmb3IgdGhlIGZhY3QgdGhhdCByZW1vdmluZyB0aGVcbiAgICAgICAgLy8gZG9jdW1lbnQgc2xpZGVzIGV2ZXJ5dGhpbmcgYmFjayBvbmUgc2xvdC5cbiAgICAgICAgaWYgKHRvID4gZnJvbSkge1xuICAgICAgICAgIC0tdG87XG4gICAgICAgIH1cblxuICAgICAgICBvYnNlcnZlQ2FsbGJhY2tzLm1vdmVkVG8oXG4gICAgICAgICAgdHJhbnNmb3JtKEVKU09OLmNsb25lKHRoaXMuZG9jcy5nZXQoaWQpKSksXG4gICAgICAgICAgZnJvbSxcbiAgICAgICAgICB0byxcbiAgICAgICAgICBiZWZvcmUgfHwgbnVsbFxuICAgICAgICApO1xuICAgICAgfSxcbiAgICAgIHJlbW92ZWQoaWQpIHtcbiAgICAgICAgaWYgKCEob2JzZXJ2ZUNhbGxiYWNrcy5yZW1vdmVkQXQgfHwgb2JzZXJ2ZUNhbGxiYWNrcy5yZW1vdmVkKSkge1xuICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIHRlY2huaWNhbGx5IG1heWJlIHRoZXJlIHNob3VsZCBiZSBhbiBFSlNPTi5jbG9uZSBoZXJlLCBidXQgaXQncyBhYm91dFxuICAgICAgICAvLyB0byBiZSByZW1vdmVkIGZyb20gdGhpcy5kb2NzIVxuICAgICAgICBjb25zdCBkb2MgPSB0cmFuc2Zvcm0odGhpcy5kb2NzLmdldChpZCkpO1xuXG4gICAgICAgIGlmIChvYnNlcnZlQ2FsbGJhY2tzLnJlbW92ZWRBdCkge1xuICAgICAgICAgIG9ic2VydmVDYWxsYmFja3MucmVtb3ZlZEF0KGRvYywgaW5kaWNlcyA/IHRoaXMuZG9jcy5pbmRleE9mKGlkKSA6IC0xKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBvYnNlcnZlQ2FsbGJhY2tzLnJlbW92ZWQoZG9jKTtcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICB9O1xuICB9IGVsc2Uge1xuICAgIG9ic2VydmVDaGFuZ2VzQ2FsbGJhY2tzID0ge1xuICAgICAgYWRkZWQoaWQsIGZpZWxkcykge1xuICAgICAgICBpZiAoIXN1cHByZXNzZWQgJiYgb2JzZXJ2ZUNhbGxiYWNrcy5hZGRlZCkge1xuICAgICAgICAgIG9ic2VydmVDYWxsYmFja3MuYWRkZWQodHJhbnNmb3JtKE9iamVjdC5hc3NpZ24oZmllbGRzLCB7X2lkOiBpZH0pKSk7XG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgICBjaGFuZ2VkKGlkLCBmaWVsZHMpIHtcbiAgICAgICAgaWYgKG9ic2VydmVDYWxsYmFja3MuY2hhbmdlZCkge1xuICAgICAgICAgIGNvbnN0IG9sZERvYyA9IHRoaXMuZG9jcy5nZXQoaWQpO1xuICAgICAgICAgIGNvbnN0IGRvYyA9IEVKU09OLmNsb25lKG9sZERvYyk7XG5cbiAgICAgICAgICBEaWZmU2VxdWVuY2UuYXBwbHlDaGFuZ2VzKGRvYywgZmllbGRzKTtcblxuICAgICAgICAgIG9ic2VydmVDYWxsYmFja3MuY2hhbmdlZChcbiAgICAgICAgICAgIHRyYW5zZm9ybShkb2MpLFxuICAgICAgICAgICAgdHJhbnNmb3JtKEVKU09OLmNsb25lKG9sZERvYykpXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICAgIHJlbW92ZWQoaWQpIHtcbiAgICAgICAgaWYgKG9ic2VydmVDYWxsYmFja3MucmVtb3ZlZCkge1xuICAgICAgICAgIG9ic2VydmVDYWxsYmFja3MucmVtb3ZlZCh0cmFuc2Zvcm0odGhpcy5kb2NzLmdldChpZCkpKTtcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgY2hhbmdlT2JzZXJ2ZXIgPSBuZXcgTG9jYWxDb2xsZWN0aW9uLl9DYWNoaW5nQ2hhbmdlT2JzZXJ2ZXIoe1xuICAgIGNhbGxiYWNrczogb2JzZXJ2ZUNoYW5nZXNDYWxsYmFja3NcbiAgfSk7XG5cbiAgLy8gQ2FjaGluZ0NoYW5nZU9ic2VydmVyIGNsb25lcyBhbGwgcmVjZWl2ZWQgaW5wdXQgb24gaXRzIGNhbGxiYWNrc1xuICAvLyBTbyB3ZSBjYW4gbWFyayBpdCBhcyBzYWZlIHRvIHJlZHVjZSB0aGUgZWpzb24gY2xvbmVzLlxuICAvLyBUaGlzIGlzIHRlc3RlZCBieSB0aGUgYG1vbmdvLWxpdmVkYXRhIC0gKGV4dGVuZGVkKSBzY3JpYmJsaW5nYCB0ZXN0c1xuICBjaGFuZ2VPYnNlcnZlci5hcHBseUNoYW5nZS5fZnJvbU9ic2VydmUgPSB0cnVlO1xuICBjb25zdCBoYW5kbGUgPSBjdXJzb3Iub2JzZXJ2ZUNoYW5nZXMoY2hhbmdlT2JzZXJ2ZXIuYXBwbHlDaGFuZ2UsXG4gICAgeyBub25NdXRhdGluZ0NhbGxiYWNrczogdHJ1ZSB9KTtcblxuICBzdXBwcmVzc2VkID0gZmFsc2U7XG5cbiAgcmV0dXJuIGhhbmRsZTtcbn07XG5cbkxvY2FsQ29sbGVjdGlvbi5fb2JzZXJ2ZUNhbGxiYWNrc0FyZU9yZGVyZWQgPSBjYWxsYmFja3MgPT4ge1xuICBpZiAoY2FsbGJhY2tzLmFkZGVkICYmIGNhbGxiYWNrcy5hZGRlZEF0KSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdQbGVhc2Ugc3BlY2lmeSBvbmx5IG9uZSBvZiBhZGRlZCgpIGFuZCBhZGRlZEF0KCknKTtcbiAgfVxuXG4gIGlmIChjYWxsYmFja3MuY2hhbmdlZCAmJiBjYWxsYmFja3MuY2hhbmdlZEF0KSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdQbGVhc2Ugc3BlY2lmeSBvbmx5IG9uZSBvZiBjaGFuZ2VkKCkgYW5kIGNoYW5nZWRBdCgpJyk7XG4gIH1cblxuICBpZiAoY2FsbGJhY2tzLnJlbW92ZWQgJiYgY2FsbGJhY2tzLnJlbW92ZWRBdCkge1xuICAgIHRocm93IG5ldyBFcnJvcignUGxlYXNlIHNwZWNpZnkgb25seSBvbmUgb2YgcmVtb3ZlZCgpIGFuZCByZW1vdmVkQXQoKScpO1xuICB9XG5cbiAgcmV0dXJuICEhKFxuICAgIGNhbGxiYWNrcy5hZGRlZEF0IHx8XG4gICAgY2FsbGJhY2tzLmNoYW5nZWRBdCB8fFxuICAgIGNhbGxiYWNrcy5tb3ZlZFRvIHx8XG4gICAgY2FsbGJhY2tzLnJlbW92ZWRBdFxuICApO1xufTtcblxuTG9jYWxDb2xsZWN0aW9uLl9vYnNlcnZlQ2hhbmdlc0NhbGxiYWNrc0FyZU9yZGVyZWQgPSBjYWxsYmFja3MgPT4ge1xuICBpZiAoY2FsbGJhY2tzLmFkZGVkICYmIGNhbGxiYWNrcy5hZGRlZEJlZm9yZSkge1xuICAgIHRocm93IG5ldyBFcnJvcignUGxlYXNlIHNwZWNpZnkgb25seSBvbmUgb2YgYWRkZWQoKSBhbmQgYWRkZWRCZWZvcmUoKScpO1xuICB9XG5cbiAgcmV0dXJuICEhKGNhbGxiYWNrcy5hZGRlZEJlZm9yZSB8fCBjYWxsYmFja3MubW92ZWRCZWZvcmUpO1xufTtcblxuTG9jYWxDb2xsZWN0aW9uLl9yZW1vdmVGcm9tUmVzdWx0cyA9IChxdWVyeSwgZG9jKSA9PiB7XG4gIGlmIChxdWVyeS5vcmRlcmVkKSB7XG4gICAgY29uc3QgaSA9IExvY2FsQ29sbGVjdGlvbi5fZmluZEluT3JkZXJlZFJlc3VsdHMocXVlcnksIGRvYyk7XG5cbiAgICBxdWVyeS5yZW1vdmVkKGRvYy5faWQpO1xuICAgIHF1ZXJ5LnJlc3VsdHMuc3BsaWNlKGksIDEpO1xuICB9IGVsc2Uge1xuICAgIGNvbnN0IGlkID0gZG9jLl9pZDsgIC8vIGluIGNhc2UgY2FsbGJhY2sgbXV0YXRlcyBkb2NcblxuICAgIHF1ZXJ5LnJlbW92ZWQoZG9jLl9pZCk7XG4gICAgcXVlcnkucmVzdWx0cy5yZW1vdmUoaWQpO1xuICB9XG59O1xuXG4vLyBJcyB0aGlzIHNlbGVjdG9yIGp1c3Qgc2hvcnRoYW5kIGZvciBsb29rdXAgYnkgX2lkP1xuTG9jYWxDb2xsZWN0aW9uLl9zZWxlY3RvcklzSWQgPSBzZWxlY3RvciA9PlxuICB0eXBlb2Ygc2VsZWN0b3IgPT09ICdudW1iZXInIHx8XG4gIHR5cGVvZiBzZWxlY3RvciA9PT0gJ3N0cmluZycgfHxcbiAgc2VsZWN0b3IgaW5zdGFuY2VvZiBNb25nb0lELk9iamVjdElEXG47XG5cbi8vIElzIHRoZSBzZWxlY3RvciBqdXN0IGxvb2t1cCBieSBfaWQgKHNob3J0aGFuZCBvciBub3QpP1xuTG9jYWxDb2xsZWN0aW9uLl9zZWxlY3RvcklzSWRQZXJoYXBzQXNPYmplY3QgPSBzZWxlY3RvciA9PlxuICBMb2NhbENvbGxlY3Rpb24uX3NlbGVjdG9ySXNJZChzZWxlY3RvcikgfHxcbiAgTG9jYWxDb2xsZWN0aW9uLl9zZWxlY3RvcklzSWQoc2VsZWN0b3IgJiYgc2VsZWN0b3IuX2lkKSAmJlxuICBPYmplY3Qua2V5cyhzZWxlY3RvcikubGVuZ3RoID09PSAxXG47XG5cbkxvY2FsQ29sbGVjdGlvbi5fdXBkYXRlSW5SZXN1bHRzID0gKHF1ZXJ5LCBkb2MsIG9sZF9kb2MpID0+IHtcbiAgaWYgKCFFSlNPTi5lcXVhbHMoZG9jLl9pZCwgb2xkX2RvYy5faWQpKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdDYW5cXCd0IGNoYW5nZSBhIGRvY1xcJ3MgX2lkIHdoaWxlIHVwZGF0aW5nJyk7XG4gIH1cblxuICBjb25zdCBwcm9qZWN0aW9uRm4gPSBxdWVyeS5wcm9qZWN0aW9uRm47XG4gIGNvbnN0IGNoYW5nZWRGaWVsZHMgPSBEaWZmU2VxdWVuY2UubWFrZUNoYW5nZWRGaWVsZHMoXG4gICAgcHJvamVjdGlvbkZuKGRvYyksXG4gICAgcHJvamVjdGlvbkZuKG9sZF9kb2MpXG4gICk7XG5cbiAgaWYgKCFxdWVyeS5vcmRlcmVkKSB7XG4gICAgaWYgKE9iamVjdC5rZXlzKGNoYW5nZWRGaWVsZHMpLmxlbmd0aCkge1xuICAgICAgcXVlcnkuY2hhbmdlZChkb2MuX2lkLCBjaGFuZ2VkRmllbGRzKTtcbiAgICAgIHF1ZXJ5LnJlc3VsdHMuc2V0KGRvYy5faWQsIGRvYyk7XG4gICAgfVxuXG4gICAgcmV0dXJuO1xuICB9XG5cbiAgY29uc3Qgb2xkX2lkeCA9IExvY2FsQ29sbGVjdGlvbi5fZmluZEluT3JkZXJlZFJlc3VsdHMocXVlcnksIGRvYyk7XG5cbiAgaWYgKE9iamVjdC5rZXlzKGNoYW5nZWRGaWVsZHMpLmxlbmd0aCkge1xuICAgIHF1ZXJ5LmNoYW5nZWQoZG9jLl9pZCwgY2hhbmdlZEZpZWxkcyk7XG4gIH1cblxuICBpZiAoIXF1ZXJ5LnNvcnRlcikge1xuICAgIHJldHVybjtcbiAgfVxuXG4gIC8vIGp1c3QgdGFrZSBpdCBvdXQgYW5kIHB1dCBpdCBiYWNrIGluIGFnYWluLCBhbmQgc2VlIGlmIHRoZSBpbmRleCBjaGFuZ2VzXG4gIHF1ZXJ5LnJlc3VsdHMuc3BsaWNlKG9sZF9pZHgsIDEpO1xuXG4gIGNvbnN0IG5ld19pZHggPSBMb2NhbENvbGxlY3Rpb24uX2luc2VydEluU29ydGVkTGlzdChcbiAgICBxdWVyeS5zb3J0ZXIuZ2V0Q29tcGFyYXRvcih7ZGlzdGFuY2VzOiBxdWVyeS5kaXN0YW5jZXN9KSxcbiAgICBxdWVyeS5yZXN1bHRzLFxuICAgIGRvY1xuICApO1xuXG4gIGlmIChvbGRfaWR4ICE9PSBuZXdfaWR4KSB7XG4gICAgbGV0IG5leHQgPSBxdWVyeS5yZXN1bHRzW25ld19pZHggKyAxXTtcbiAgICBpZiAobmV4dCkge1xuICAgICAgbmV4dCA9IG5leHQuX2lkO1xuICAgIH0gZWxzZSB7XG4gICAgICBuZXh0ID0gbnVsbDtcbiAgICB9XG5cbiAgICBxdWVyeS5tb3ZlZEJlZm9yZSAmJiBxdWVyeS5tb3ZlZEJlZm9yZShkb2MuX2lkLCBuZXh0KTtcbiAgfVxufTtcblxuY29uc3QgTU9ESUZJRVJTID0ge1xuICAkY3VycmVudERhdGUodGFyZ2V0LCBmaWVsZCwgYXJnKSB7XG4gICAgaWYgKHR5cGVvZiBhcmcgPT09ICdvYmplY3QnICYmIGhhc093bi5jYWxsKGFyZywgJyR0eXBlJykpIHtcbiAgICAgIGlmIChhcmcuJHR5cGUgIT09ICdkYXRlJykge1xuICAgICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcihcbiAgICAgICAgICAnTWluaW1vbmdvIGRvZXMgY3VycmVudGx5IG9ubHkgc3VwcG9ydCB0aGUgZGF0ZSB0eXBlIGluICcgK1xuICAgICAgICAgICckY3VycmVudERhdGUgbW9kaWZpZXJzJyxcbiAgICAgICAgICB7ZmllbGR9XG4gICAgICAgICk7XG4gICAgICB9XG4gICAgfSBlbHNlIGlmIChhcmcgIT09IHRydWUpIHtcbiAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKCdJbnZhbGlkICRjdXJyZW50RGF0ZSBtb2RpZmllcicsIHtmaWVsZH0pO1xuICAgIH1cblxuICAgIHRhcmdldFtmaWVsZF0gPSBuZXcgRGF0ZSgpO1xuICB9LFxuICAkaW5jKHRhcmdldCwgZmllbGQsIGFyZykge1xuICAgIGlmICh0eXBlb2YgYXJnICE9PSAnbnVtYmVyJykge1xuICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoJ01vZGlmaWVyICRpbmMgYWxsb3dlZCBmb3IgbnVtYmVycyBvbmx5Jywge2ZpZWxkfSk7XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkIGluIHRhcmdldCkge1xuICAgICAgaWYgKHR5cGVvZiB0YXJnZXRbZmllbGRdICE9PSAnbnVtYmVyJykge1xuICAgICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcihcbiAgICAgICAgICAnQ2Fubm90IGFwcGx5ICRpbmMgbW9kaWZpZXIgdG8gbm9uLW51bWJlcicsXG4gICAgICAgICAge2ZpZWxkfVxuICAgICAgICApO1xuICAgICAgfVxuXG4gICAgICB0YXJnZXRbZmllbGRdICs9IGFyZztcbiAgICB9IGVsc2Uge1xuICAgICAgdGFyZ2V0W2ZpZWxkXSA9IGFyZztcbiAgICB9XG4gIH0sXG4gICRtaW4odGFyZ2V0LCBmaWVsZCwgYXJnKSB7XG4gICAgaWYgKHR5cGVvZiBhcmcgIT09ICdudW1iZXInKSB7XG4gICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcignTW9kaWZpZXIgJG1pbiBhbGxvd2VkIGZvciBudW1iZXJzIG9ubHknLCB7ZmllbGR9KTtcbiAgICB9XG5cbiAgICBpZiAoZmllbGQgaW4gdGFyZ2V0KSB7XG4gICAgICBpZiAodHlwZW9mIHRhcmdldFtmaWVsZF0gIT09ICdudW1iZXInKSB7XG4gICAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKFxuICAgICAgICAgICdDYW5ub3QgYXBwbHkgJG1pbiBtb2RpZmllciB0byBub24tbnVtYmVyJyxcbiAgICAgICAgICB7ZmllbGR9XG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIGlmICh0YXJnZXRbZmllbGRdID4gYXJnKSB7XG4gICAgICAgIHRhcmdldFtmaWVsZF0gPSBhcmc7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHRhcmdldFtmaWVsZF0gPSBhcmc7XG4gICAgfVxuICB9LFxuICAkbWF4KHRhcmdldCwgZmllbGQsIGFyZykge1xuICAgIGlmICh0eXBlb2YgYXJnICE9PSAnbnVtYmVyJykge1xuICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoJ01vZGlmaWVyICRtYXggYWxsb3dlZCBmb3IgbnVtYmVycyBvbmx5Jywge2ZpZWxkfSk7XG4gICAgfVxuXG4gICAgaWYgKGZpZWxkIGluIHRhcmdldCkge1xuICAgICAgaWYgKHR5cGVvZiB0YXJnZXRbZmllbGRdICE9PSAnbnVtYmVyJykge1xuICAgICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcihcbiAgICAgICAgICAnQ2Fubm90IGFwcGx5ICRtYXggbW9kaWZpZXIgdG8gbm9uLW51bWJlcicsXG4gICAgICAgICAge2ZpZWxkfVxuICAgICAgICApO1xuICAgICAgfVxuXG4gICAgICBpZiAodGFyZ2V0W2ZpZWxkXSA8IGFyZykge1xuICAgICAgICB0YXJnZXRbZmllbGRdID0gYXJnO1xuICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICB0YXJnZXRbZmllbGRdID0gYXJnO1xuICAgIH1cbiAgfSxcbiAgJG11bCh0YXJnZXQsIGZpZWxkLCBhcmcpIHtcbiAgICBpZiAodHlwZW9mIGFyZyAhPT0gJ251bWJlcicpIHtcbiAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKCdNb2RpZmllciAkbXVsIGFsbG93ZWQgZm9yIG51bWJlcnMgb25seScsIHtmaWVsZH0pO1xuICAgIH1cblxuICAgIGlmIChmaWVsZCBpbiB0YXJnZXQpIHtcbiAgICAgIGlmICh0eXBlb2YgdGFyZ2V0W2ZpZWxkXSAhPT0gJ251bWJlcicpIHtcbiAgICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoXG4gICAgICAgICAgJ0Nhbm5vdCBhcHBseSAkbXVsIG1vZGlmaWVyIHRvIG5vbi1udW1iZXInLFxuICAgICAgICAgIHtmaWVsZH1cbiAgICAgICAgKTtcbiAgICAgIH1cblxuICAgICAgdGFyZ2V0W2ZpZWxkXSAqPSBhcmc7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRhcmdldFtmaWVsZF0gPSAwO1xuICAgIH1cbiAgfSxcbiAgJHJlbmFtZSh0YXJnZXQsIGZpZWxkLCBhcmcsIGtleXBhdGgsIGRvYykge1xuICAgIC8vIG5vIGlkZWEgd2h5IG1vbmdvIGhhcyB0aGlzIHJlc3RyaWN0aW9uLi5cbiAgICBpZiAoa2V5cGF0aCA9PT0gYXJnKSB7XG4gICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcignJHJlbmFtZSBzb3VyY2UgbXVzdCBkaWZmZXIgZnJvbSB0YXJnZXQnLCB7ZmllbGR9KTtcbiAgICB9XG5cbiAgICBpZiAodGFyZ2V0ID09PSBudWxsKSB7XG4gICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcignJHJlbmFtZSBzb3VyY2UgZmllbGQgaW52YWxpZCcsIHtmaWVsZH0pO1xuICAgIH1cblxuICAgIGlmICh0eXBlb2YgYXJnICE9PSAnc3RyaW5nJykge1xuICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoJyRyZW5hbWUgdGFyZ2V0IG11c3QgYmUgYSBzdHJpbmcnLCB7ZmllbGR9KTtcbiAgICB9XG5cbiAgICBpZiAoYXJnLmluY2x1ZGVzKCdcXDAnKSkge1xuICAgICAgLy8gTnVsbCBieXRlcyBhcmUgbm90IGFsbG93ZWQgaW4gTW9uZ28gZmllbGQgbmFtZXNcbiAgICAgIC8vIGh0dHBzOi8vZG9jcy5tb25nb2RiLmNvbS9tYW51YWwvcmVmZXJlbmNlL2xpbWl0cy8jUmVzdHJpY3Rpb25zLW9uLUZpZWxkLU5hbWVzXG4gICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcihcbiAgICAgICAgJ1RoZSBcXCd0b1xcJyBmaWVsZCBmb3IgJHJlbmFtZSBjYW5ub3QgY29udGFpbiBhbiBlbWJlZGRlZCBudWxsIGJ5dGUnLFxuICAgICAgICB7ZmllbGR9XG4gICAgICApO1xuICAgIH1cblxuICAgIGlmICh0YXJnZXQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnN0IG9iamVjdCA9IHRhcmdldFtmaWVsZF07XG5cbiAgICBkZWxldGUgdGFyZ2V0W2ZpZWxkXTtcblxuICAgIGNvbnN0IGtleXBhcnRzID0gYXJnLnNwbGl0KCcuJyk7XG4gICAgY29uc3QgdGFyZ2V0MiA9IGZpbmRNb2RUYXJnZXQoZG9jLCBrZXlwYXJ0cywge2ZvcmJpZEFycmF5OiB0cnVlfSk7XG5cbiAgICBpZiAodGFyZ2V0MiA9PT0gbnVsbCkge1xuICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoJyRyZW5hbWUgdGFyZ2V0IGZpZWxkIGludmFsaWQnLCB7ZmllbGR9KTtcbiAgICB9XG5cbiAgICB0YXJnZXQyW2tleXBhcnRzLnBvcCgpXSA9IG9iamVjdDtcbiAgfSxcbiAgJHNldCh0YXJnZXQsIGZpZWxkLCBhcmcpIHtcbiAgICBpZiAodGFyZ2V0ICE9PSBPYmplY3QodGFyZ2V0KSkgeyAvLyBub3QgYW4gYXJyYXkgb3IgYW4gb2JqZWN0XG4gICAgICBjb25zdCBlcnJvciA9IE1pbmltb25nb0Vycm9yKFxuICAgICAgICAnQ2Fubm90IHNldCBwcm9wZXJ0eSBvbiBub24tb2JqZWN0IGZpZWxkJyxcbiAgICAgICAge2ZpZWxkfVxuICAgICAgKTtcbiAgICAgIGVycm9yLnNldFByb3BlcnR5RXJyb3IgPSB0cnVlO1xuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuXG4gICAgaWYgKHRhcmdldCA9PT0gbnVsbCkge1xuICAgICAgY29uc3QgZXJyb3IgPSBNaW5pbW9uZ29FcnJvcignQ2Fubm90IHNldCBwcm9wZXJ0eSBvbiBudWxsJywge2ZpZWxkfSk7XG4gICAgICBlcnJvci5zZXRQcm9wZXJ0eUVycm9yID0gdHJ1ZTtcbiAgICAgIHRocm93IGVycm9yO1xuICAgIH1cblxuICAgIGFzc2VydEhhc1ZhbGlkRmllbGROYW1lcyhhcmcpO1xuXG4gICAgdGFyZ2V0W2ZpZWxkXSA9IGFyZztcbiAgfSxcbiAgJHNldE9uSW5zZXJ0KHRhcmdldCwgZmllbGQsIGFyZykge1xuICAgIC8vIGNvbnZlcnRlZCB0byBgJHNldGAgaW4gYF9tb2RpZnlgXG4gIH0sXG4gICR1bnNldCh0YXJnZXQsIGZpZWxkLCBhcmcpIHtcbiAgICBpZiAodGFyZ2V0ICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGlmICh0YXJnZXQgaW5zdGFuY2VvZiBBcnJheSkge1xuICAgICAgICBpZiAoZmllbGQgaW4gdGFyZ2V0KSB7XG4gICAgICAgICAgdGFyZ2V0W2ZpZWxkXSA9IG51bGw7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGRlbGV0ZSB0YXJnZXRbZmllbGRdO1xuICAgICAgfVxuICAgIH1cbiAgfSxcbiAgJHB1c2godGFyZ2V0LCBmaWVsZCwgYXJnKSB7XG4gICAgaWYgKHRhcmdldFtmaWVsZF0gPT09IHVuZGVmaW5lZCkge1xuICAgICAgdGFyZ2V0W2ZpZWxkXSA9IFtdO1xuICAgIH1cblxuICAgIGlmICghKHRhcmdldFtmaWVsZF0gaW5zdGFuY2VvZiBBcnJheSkpIHtcbiAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKCdDYW5ub3QgYXBwbHkgJHB1c2ggbW9kaWZpZXIgdG8gbm9uLWFycmF5Jywge2ZpZWxkfSk7XG4gICAgfVxuXG4gICAgaWYgKCEoYXJnICYmIGFyZy4kZWFjaCkpIHtcbiAgICAgIC8vIFNpbXBsZSBtb2RlOiBub3QgJGVhY2hcbiAgICAgIGFzc2VydEhhc1ZhbGlkRmllbGROYW1lcyhhcmcpO1xuXG4gICAgICB0YXJnZXRbZmllbGRdLnB1c2goYXJnKTtcblxuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIC8vIEZhbmN5IG1vZGU6ICRlYWNoIChhbmQgbWF5YmUgJHNsaWNlIGFuZCAkc29ydCBhbmQgJHBvc2l0aW9uKVxuICAgIGNvbnN0IHRvUHVzaCA9IGFyZy4kZWFjaDtcbiAgICBpZiAoISh0b1B1c2ggaW5zdGFuY2VvZiBBcnJheSkpIHtcbiAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKCckZWFjaCBtdXN0IGJlIGFuIGFycmF5Jywge2ZpZWxkfSk7XG4gICAgfVxuXG4gICAgYXNzZXJ0SGFzVmFsaWRGaWVsZE5hbWVzKHRvUHVzaCk7XG5cbiAgICAvLyBQYXJzZSAkcG9zaXRpb25cbiAgICBsZXQgcG9zaXRpb24gPSB1bmRlZmluZWQ7XG4gICAgaWYgKCckcG9zaXRpb24nIGluIGFyZykge1xuICAgICAgaWYgKHR5cGVvZiBhcmcuJHBvc2l0aW9uICE9PSAnbnVtYmVyJykge1xuICAgICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcignJHBvc2l0aW9uIG11c3QgYmUgYSBudW1lcmljIHZhbHVlJywge2ZpZWxkfSk7XG4gICAgICB9XG5cbiAgICAgIC8vIFhYWCBzaG91bGQgY2hlY2sgdG8gbWFrZSBzdXJlIGludGVnZXJcbiAgICAgIGlmIChhcmcuJHBvc2l0aW9uIDwgMCkge1xuICAgICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcihcbiAgICAgICAgICAnJHBvc2l0aW9uIGluICRwdXNoIG11c3QgYmUgemVybyBvciBwb3NpdGl2ZScsXG4gICAgICAgICAge2ZpZWxkfVxuICAgICAgICApO1xuICAgICAgfVxuXG4gICAgICBwb3NpdGlvbiA9IGFyZy4kcG9zaXRpb247XG4gICAgfVxuXG4gICAgLy8gUGFyc2UgJHNsaWNlLlxuICAgIGxldCBzbGljZSA9IHVuZGVmaW5lZDtcbiAgICBpZiAoJyRzbGljZScgaW4gYXJnKSB7XG4gICAgICBpZiAodHlwZW9mIGFyZy4kc2xpY2UgIT09ICdudW1iZXInKSB7XG4gICAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKCckc2xpY2UgbXVzdCBiZSBhIG51bWVyaWMgdmFsdWUnLCB7ZmllbGR9KTtcbiAgICAgIH1cblxuICAgICAgLy8gWFhYIHNob3VsZCBjaGVjayB0byBtYWtlIHN1cmUgaW50ZWdlclxuICAgICAgc2xpY2UgPSBhcmcuJHNsaWNlO1xuICAgIH1cblxuICAgIC8vIFBhcnNlICRzb3J0LlxuICAgIGxldCBzb3J0RnVuY3Rpb24gPSB1bmRlZmluZWQ7XG4gICAgaWYgKGFyZy4kc29ydCkge1xuICAgICAgaWYgKHNsaWNlID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoJyRzb3J0IHJlcXVpcmVzICRzbGljZSB0byBiZSBwcmVzZW50Jywge2ZpZWxkfSk7XG4gICAgICB9XG5cbiAgICAgIC8vIFhYWCB0aGlzIGFsbG93cyB1cyB0byB1c2UgYSAkc29ydCB3aG9zZSB2YWx1ZSBpcyBhbiBhcnJheSwgYnV0IHRoYXQnc1xuICAgICAgLy8gYWN0dWFsbHkgYW4gZXh0ZW5zaW9uIG9mIHRoZSBOb2RlIGRyaXZlciwgc28gaXQgd29uJ3Qgd29ya1xuICAgICAgLy8gc2VydmVyLXNpZGUuIENvdWxkIGJlIGNvbmZ1c2luZyFcbiAgICAgIC8vIFhYWCBpcyBpdCBjb3JyZWN0IHRoYXQgd2UgZG9uJ3QgZG8gZ2VvLXN0dWZmIGhlcmU/XG4gICAgICBzb3J0RnVuY3Rpb24gPSBuZXcgTWluaW1vbmdvLlNvcnRlcihhcmcuJHNvcnQpLmdldENvbXBhcmF0b3IoKTtcblxuICAgICAgdG9QdXNoLmZvckVhY2goZWxlbWVudCA9PiB7XG4gICAgICAgIGlmIChMb2NhbENvbGxlY3Rpb24uX2YuX3R5cGUoZWxlbWVudCkgIT09IDMpIHtcbiAgICAgICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcihcbiAgICAgICAgICAgICckcHVzaCBsaWtlIG1vZGlmaWVycyB1c2luZyAkc29ydCByZXF1aXJlIGFsbCBlbGVtZW50cyB0byBiZSAnICtcbiAgICAgICAgICAgICdvYmplY3RzJyxcbiAgICAgICAgICAgIHtmaWVsZH1cbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICB9XG5cbiAgICAvLyBBY3R1YWxseSBwdXNoLlxuICAgIGlmIChwb3NpdGlvbiA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICB0b1B1c2guZm9yRWFjaChlbGVtZW50ID0+IHtcbiAgICAgICAgdGFyZ2V0W2ZpZWxkXS5wdXNoKGVsZW1lbnQpO1xuICAgICAgfSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbnN0IHNwbGljZUFyZ3VtZW50cyA9IFtwb3NpdGlvbiwgMF07XG5cbiAgICAgIHRvUHVzaC5mb3JFYWNoKGVsZW1lbnQgPT4ge1xuICAgICAgICBzcGxpY2VBcmd1bWVudHMucHVzaChlbGVtZW50KTtcbiAgICAgIH0pO1xuXG4gICAgICB0YXJnZXRbZmllbGRdLnNwbGljZSguLi5zcGxpY2VBcmd1bWVudHMpO1xuICAgIH1cblxuICAgIC8vIEFjdHVhbGx5IHNvcnQuXG4gICAgaWYgKHNvcnRGdW5jdGlvbikge1xuICAgICAgdGFyZ2V0W2ZpZWxkXS5zb3J0KHNvcnRGdW5jdGlvbik7XG4gICAgfVxuXG4gICAgLy8gQWN0dWFsbHkgc2xpY2UuXG4gICAgaWYgKHNsaWNlICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIGlmIChzbGljZSA9PT0gMCkge1xuICAgICAgICB0YXJnZXRbZmllbGRdID0gW107IC8vIGRpZmZlcnMgZnJvbSBBcnJheS5zbGljZSFcbiAgICAgIH0gZWxzZSBpZiAoc2xpY2UgPCAwKSB7XG4gICAgICAgIHRhcmdldFtmaWVsZF0gPSB0YXJnZXRbZmllbGRdLnNsaWNlKHNsaWNlKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRhcmdldFtmaWVsZF0gPSB0YXJnZXRbZmllbGRdLnNsaWNlKDAsIHNsaWNlKTtcbiAgICAgIH1cbiAgICB9XG4gIH0sXG4gICRwdXNoQWxsKHRhcmdldCwgZmllbGQsIGFyZykge1xuICAgIGlmICghKHR5cGVvZiBhcmcgPT09ICdvYmplY3QnICYmIGFyZyBpbnN0YW5jZW9mIEFycmF5KSkge1xuICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoJ01vZGlmaWVyICRwdXNoQWxsL3B1bGxBbGwgYWxsb3dlZCBmb3IgYXJyYXlzIG9ubHknKTtcbiAgICB9XG5cbiAgICBhc3NlcnRIYXNWYWxpZEZpZWxkTmFtZXMoYXJnKTtcblxuICAgIGNvbnN0IHRvUHVzaCA9IHRhcmdldFtmaWVsZF07XG5cbiAgICBpZiAodG9QdXNoID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHRhcmdldFtmaWVsZF0gPSBhcmc7XG4gICAgfSBlbHNlIGlmICghKHRvUHVzaCBpbnN0YW5jZW9mIEFycmF5KSkge1xuICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoXG4gICAgICAgICdDYW5ub3QgYXBwbHkgJHB1c2hBbGwgbW9kaWZpZXIgdG8gbm9uLWFycmF5JyxcbiAgICAgICAge2ZpZWxkfVxuICAgICAgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdG9QdXNoLnB1c2goLi4uYXJnKTtcbiAgICB9XG4gIH0sXG4gICRhZGRUb1NldCh0YXJnZXQsIGZpZWxkLCBhcmcpIHtcbiAgICBsZXQgaXNFYWNoID0gZmFsc2U7XG5cbiAgICBpZiAodHlwZW9mIGFyZyA9PT0gJ29iamVjdCcpIHtcbiAgICAgIC8vIGNoZWNrIGlmIGZpcnN0IGtleSBpcyAnJGVhY2gnXG4gICAgICBjb25zdCBrZXlzID0gT2JqZWN0LmtleXMoYXJnKTtcbiAgICAgIGlmIChrZXlzWzBdID09PSAnJGVhY2gnKSB7XG4gICAgICAgIGlzRWFjaCA9IHRydWU7XG4gICAgICB9XG4gICAgfVxuXG4gICAgY29uc3QgdmFsdWVzID0gaXNFYWNoID8gYXJnLiRlYWNoIDogW2FyZ107XG5cbiAgICBhc3NlcnRIYXNWYWxpZEZpZWxkTmFtZXModmFsdWVzKTtcblxuICAgIGNvbnN0IHRvQWRkID0gdGFyZ2V0W2ZpZWxkXTtcbiAgICBpZiAodG9BZGQgPT09IHVuZGVmaW5lZCkge1xuICAgICAgdGFyZ2V0W2ZpZWxkXSA9IHZhbHVlcztcbiAgICB9IGVsc2UgaWYgKCEodG9BZGQgaW5zdGFuY2VvZiBBcnJheSkpIHtcbiAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKFxuICAgICAgICAnQ2Fubm90IGFwcGx5ICRhZGRUb1NldCBtb2RpZmllciB0byBub24tYXJyYXknLFxuICAgICAgICB7ZmllbGR9XG4gICAgICApO1xuICAgIH0gZWxzZSB7XG4gICAgICB2YWx1ZXMuZm9yRWFjaCh2YWx1ZSA9PiB7XG4gICAgICAgIGlmICh0b0FkZC5zb21lKGVsZW1lbnQgPT4gTG9jYWxDb2xsZWN0aW9uLl9mLl9lcXVhbCh2YWx1ZSwgZWxlbWVudCkpKSB7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgdG9BZGQucHVzaCh2YWx1ZSk7XG4gICAgICB9KTtcbiAgICB9XG4gIH0sXG4gICRwb3AodGFyZ2V0LCBmaWVsZCwgYXJnKSB7XG4gICAgaWYgKHRhcmdldCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgdG9Qb3AgPSB0YXJnZXRbZmllbGRdO1xuXG4gICAgaWYgKHRvUG9wID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAoISh0b1BvcCBpbnN0YW5jZW9mIEFycmF5KSkge1xuICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoJ0Nhbm5vdCBhcHBseSAkcG9wIG1vZGlmaWVyIHRvIG5vbi1hcnJheScsIHtmaWVsZH0pO1xuICAgIH1cblxuICAgIGlmICh0eXBlb2YgYXJnID09PSAnbnVtYmVyJyAmJiBhcmcgPCAwKSB7XG4gICAgICB0b1BvcC5zcGxpY2UoMCwgMSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRvUG9wLnBvcCgpO1xuICAgIH1cbiAgfSxcbiAgJHB1bGwodGFyZ2V0LCBmaWVsZCwgYXJnKSB7XG4gICAgaWYgKHRhcmdldCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgY29uc3QgdG9QdWxsID0gdGFyZ2V0W2ZpZWxkXTtcbiAgICBpZiAodG9QdWxsID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAoISh0b1B1bGwgaW5zdGFuY2VvZiBBcnJheSkpIHtcbiAgICAgIHRocm93IE1pbmltb25nb0Vycm9yKFxuICAgICAgICAnQ2Fubm90IGFwcGx5ICRwdWxsL3B1bGxBbGwgbW9kaWZpZXIgdG8gbm9uLWFycmF5JyxcbiAgICAgICAge2ZpZWxkfVxuICAgICAgKTtcbiAgICB9XG5cbiAgICBsZXQgb3V0O1xuICAgIGlmIChhcmcgIT0gbnVsbCAmJiB0eXBlb2YgYXJnID09PSAnb2JqZWN0JyAmJiAhKGFyZyBpbnN0YW5jZW9mIEFycmF5KSkge1xuICAgICAgLy8gWFhYIHdvdWxkIGJlIG11Y2ggbmljZXIgdG8gY29tcGlsZSB0aGlzIG9uY2UsIHJhdGhlciB0aGFuXG4gICAgICAvLyBmb3IgZWFjaCBkb2N1bWVudCB3ZSBtb2RpZnkuLiBidXQgdXN1YWxseSB3ZSdyZSBub3RcbiAgICAgIC8vIG1vZGlmeWluZyB0aGF0IG1hbnkgZG9jdW1lbnRzLCBzbyB3ZSdsbCBsZXQgaXQgc2xpZGUgZm9yXG4gICAgICAvLyBub3dcblxuICAgICAgLy8gWFhYIE1pbmltb25nby5NYXRjaGVyIGlzbid0IHVwIGZvciB0aGUgam9iLCBiZWNhdXNlIHdlIG5lZWRcbiAgICAgIC8vIHRvIHBlcm1pdCBzdHVmZiBsaWtlIHskcHVsbDoge2E6IHskZ3Q6IDR9fX0uLiBzb21ldGhpbmdcbiAgICAgIC8vIGxpa2UgeyRndDogNH0gaXMgbm90IG5vcm1hbGx5IGEgY29tcGxldGUgc2VsZWN0b3IuXG4gICAgICAvLyBzYW1lIGlzc3VlIGFzICRlbGVtTWF0Y2ggcG9zc2libHk/XG4gICAgICBjb25zdCBtYXRjaGVyID0gbmV3IE1pbmltb25nby5NYXRjaGVyKGFyZyk7XG5cbiAgICAgIG91dCA9IHRvUHVsbC5maWx0ZXIoZWxlbWVudCA9PiAhbWF0Y2hlci5kb2N1bWVudE1hdGNoZXMoZWxlbWVudCkucmVzdWx0KTtcbiAgICB9IGVsc2Uge1xuICAgICAgb3V0ID0gdG9QdWxsLmZpbHRlcihlbGVtZW50ID0+ICFMb2NhbENvbGxlY3Rpb24uX2YuX2VxdWFsKGVsZW1lbnQsIGFyZykpO1xuICAgIH1cblxuICAgIHRhcmdldFtmaWVsZF0gPSBvdXQ7XG4gIH0sXG4gICRwdWxsQWxsKHRhcmdldCwgZmllbGQsIGFyZykge1xuICAgIGlmICghKHR5cGVvZiBhcmcgPT09ICdvYmplY3QnICYmIGFyZyBpbnN0YW5jZW9mIEFycmF5KSkge1xuICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoXG4gICAgICAgICdNb2RpZmllciAkcHVzaEFsbC9wdWxsQWxsIGFsbG93ZWQgZm9yIGFycmF5cyBvbmx5JyxcbiAgICAgICAge2ZpZWxkfVxuICAgICAgKTtcbiAgICB9XG5cbiAgICBpZiAodGFyZ2V0ID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjb25zdCB0b1B1bGwgPSB0YXJnZXRbZmllbGRdO1xuXG4gICAgaWYgKHRvUHVsbCA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKCEodG9QdWxsIGluc3RhbmNlb2YgQXJyYXkpKSB7XG4gICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcihcbiAgICAgICAgJ0Nhbm5vdCBhcHBseSAkcHVsbC9wdWxsQWxsIG1vZGlmaWVyIHRvIG5vbi1hcnJheScsXG4gICAgICAgIHtmaWVsZH1cbiAgICAgICk7XG4gICAgfVxuXG4gICAgdGFyZ2V0W2ZpZWxkXSA9IHRvUHVsbC5maWx0ZXIob2JqZWN0ID0+XG4gICAgICAhYXJnLnNvbWUoZWxlbWVudCA9PiBMb2NhbENvbGxlY3Rpb24uX2YuX2VxdWFsKG9iamVjdCwgZWxlbWVudCkpXG4gICAgKTtcbiAgfSxcbiAgJGJpdCh0YXJnZXQsIGZpZWxkLCBhcmcpIHtcbiAgICAvLyBYWFggbW9uZ28gb25seSBzdXBwb3J0cyAkYml0IG9uIGludGVnZXJzLCBhbmQgd2Ugb25seSBzdXBwb3J0XG4gICAgLy8gbmF0aXZlIGphdmFzY3JpcHQgbnVtYmVycyAoZG91Ymxlcykgc28gZmFyLCBzbyB3ZSBjYW4ndCBzdXBwb3J0ICRiaXRcbiAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcignJGJpdCBpcyBub3Qgc3VwcG9ydGVkJywge2ZpZWxkfSk7XG4gIH0sXG4gICR2KCkge1xuICAgIC8vIEFzIGRpc2N1c3NlZCBpbiBodHRwczovL2dpdGh1Yi5jb20vbWV0ZW9yL21ldGVvci9pc3N1ZXMvOTYyMyxcbiAgICAvLyB0aGUgYCR2YCBvcGVyYXRvciBpcyBub3QgbmVlZGVkIGJ5IE1ldGVvciwgYnV0IHByb2JsZW1zIGNhbiBvY2N1ciBpZlxuICAgIC8vIGl0J3Mgbm90IGF0IGxlYXN0IGNhbGxhYmxlIChhcyBvZiBNb25nbyA+PSAzLjYpLiBJdCdzIGRlZmluZWQgaGVyZSBhc1xuICAgIC8vIGEgbm8tb3AgdG8gd29yayBhcm91bmQgdGhlc2UgcHJvYmxlbXMuXG4gIH1cbn07XG5cbmNvbnN0IE5PX0NSRUFURV9NT0RJRklFUlMgPSB7XG4gICRwb3A6IHRydWUsXG4gICRwdWxsOiB0cnVlLFxuICAkcHVsbEFsbDogdHJ1ZSxcbiAgJHJlbmFtZTogdHJ1ZSxcbiAgJHVuc2V0OiB0cnVlXG59O1xuXG4vLyBNYWtlIHN1cmUgZmllbGQgbmFtZXMgZG8gbm90IGNvbnRhaW4gTW9uZ28gcmVzdHJpY3RlZFxuLy8gY2hhcmFjdGVycyAoJy4nLCAnJCcsICdcXDAnKS5cbi8vIGh0dHBzOi8vZG9jcy5tb25nb2RiLmNvbS9tYW51YWwvcmVmZXJlbmNlL2xpbWl0cy8jUmVzdHJpY3Rpb25zLW9uLUZpZWxkLU5hbWVzXG5jb25zdCBpbnZhbGlkQ2hhck1zZyA9IHtcbiAgJDogJ3N0YXJ0IHdpdGggXFwnJFxcJycsXG4gICcuJzogJ2NvbnRhaW4gXFwnLlxcJycsXG4gICdcXDAnOiAnY29udGFpbiBudWxsIGJ5dGVzJ1xufTtcblxuLy8gY2hlY2tzIGlmIGFsbCBmaWVsZCBuYW1lcyBpbiBhbiBvYmplY3QgYXJlIHZhbGlkXG5mdW5jdGlvbiBhc3NlcnRIYXNWYWxpZEZpZWxkTmFtZXMoZG9jKSB7XG4gIGlmIChkb2MgJiYgdHlwZW9mIGRvYyA9PT0gJ29iamVjdCcpIHtcbiAgICBKU09OLnN0cmluZ2lmeShkb2MsIChrZXksIHZhbHVlKSA9PiB7XG4gICAgICBhc3NlcnRJc1ZhbGlkRmllbGROYW1lKGtleSk7XG4gICAgICByZXR1cm4gdmFsdWU7XG4gICAgfSk7XG4gIH1cbn1cblxuZnVuY3Rpb24gYXNzZXJ0SXNWYWxpZEZpZWxkTmFtZShrZXkpIHtcbiAgbGV0IG1hdGNoO1xuICBpZiAodHlwZW9mIGtleSA9PT0gJ3N0cmluZycgJiYgKG1hdGNoID0ga2V5Lm1hdGNoKC9eXFwkfFxcLnxcXDAvKSkpIHtcbiAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcihgS2V5ICR7a2V5fSBtdXN0IG5vdCAke2ludmFsaWRDaGFyTXNnW21hdGNoWzBdXX1gKTtcbiAgfVxufVxuXG4vLyBmb3IgYS5iLmMuMi5kLmUsIGtleXBhcnRzIHNob3VsZCBiZSBbJ2EnLCAnYicsICdjJywgJzInLCAnZCcsICdlJ10sXG4vLyBhbmQgdGhlbiB5b3Ugd291bGQgb3BlcmF0ZSBvbiB0aGUgJ2UnIHByb3BlcnR5IG9mIHRoZSByZXR1cm5lZFxuLy8gb2JqZWN0LlxuLy9cbi8vIGlmIG9wdGlvbnMubm9DcmVhdGUgaXMgZmFsc2V5LCBjcmVhdGVzIGludGVybWVkaWF0ZSBsZXZlbHMgb2Zcbi8vIHN0cnVjdHVyZSBhcyBuZWNlc3NhcnksIGxpa2UgbWtkaXIgLXAgKGFuZCByYWlzZXMgYW4gZXhjZXB0aW9uIGlmXG4vLyB0aGF0IHdvdWxkIG1lYW4gZ2l2aW5nIGEgbm9uLW51bWVyaWMgcHJvcGVydHkgdG8gYW4gYXJyYXkuKSBpZlxuLy8gb3B0aW9ucy5ub0NyZWF0ZSBpcyB0cnVlLCByZXR1cm4gdW5kZWZpbmVkIGluc3RlYWQuXG4vL1xuLy8gbWF5IG1vZGlmeSB0aGUgbGFzdCBlbGVtZW50IG9mIGtleXBhcnRzIHRvIHNpZ25hbCB0byB0aGUgY2FsbGVyIHRoYXQgaXQgbmVlZHNcbi8vIHRvIHVzZSBhIGRpZmZlcmVudCB2YWx1ZSB0byBpbmRleCBpbnRvIHRoZSByZXR1cm5lZCBvYmplY3QgKGZvciBleGFtcGxlLFxuLy8gWydhJywgJzAxJ10gLT4gWydhJywgMV0pLlxuLy9cbi8vIGlmIGZvcmJpZEFycmF5IGlzIHRydWUsIHJldHVybiBudWxsIGlmIHRoZSBrZXlwYXRoIGdvZXMgdGhyb3VnaCBhbiBhcnJheS5cbi8vXG4vLyBpZiBvcHRpb25zLmFycmF5SW5kaWNlcyBpcyBzZXQsIHVzZSBpdHMgZmlyc3QgZWxlbWVudCBmb3IgdGhlIChmaXJzdCkgJyQnIGluXG4vLyB0aGUgcGF0aC5cbmZ1bmN0aW9uIGZpbmRNb2RUYXJnZXQoZG9jLCBrZXlwYXJ0cywgb3B0aW9ucyA9IHt9KSB7XG4gIGxldCB1c2VkQXJyYXlJbmRleCA9IGZhbHNlO1xuXG4gIGZvciAobGV0IGkgPSAwOyBpIDwga2V5cGFydHMubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCBsYXN0ID0gaSA9PT0ga2V5cGFydHMubGVuZ3RoIC0gMTtcbiAgICBsZXQga2V5cGFydCA9IGtleXBhcnRzW2ldO1xuXG4gICAgaWYgKCFpc0luZGV4YWJsZShkb2MpKSB7XG4gICAgICBpZiAob3B0aW9ucy5ub0NyZWF0ZSkge1xuICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgfVxuXG4gICAgICBjb25zdCBlcnJvciA9IE1pbmltb25nb0Vycm9yKFxuICAgICAgICBgY2Fubm90IHVzZSB0aGUgcGFydCAnJHtrZXlwYXJ0fScgdG8gdHJhdmVyc2UgJHtkb2N9YFxuICAgICAgKTtcbiAgICAgIGVycm9yLnNldFByb3BlcnR5RXJyb3IgPSB0cnVlO1xuICAgICAgdGhyb3cgZXJyb3I7XG4gICAgfVxuXG4gICAgaWYgKGRvYyBpbnN0YW5jZW9mIEFycmF5KSB7XG4gICAgICBpZiAob3B0aW9ucy5mb3JiaWRBcnJheSkge1xuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgIH1cblxuICAgICAgaWYgKGtleXBhcnQgPT09ICckJykge1xuICAgICAgICBpZiAodXNlZEFycmF5SW5kZXgpIHtcbiAgICAgICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcignVG9vIG1hbnkgcG9zaXRpb25hbCAoaS5lLiBcXCckXFwnKSBlbGVtZW50cycpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFvcHRpb25zLmFycmF5SW5kaWNlcyB8fCAhb3B0aW9ucy5hcnJheUluZGljZXMubGVuZ3RoKSB7XG4gICAgICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoXG4gICAgICAgICAgICAnVGhlIHBvc2l0aW9uYWwgb3BlcmF0b3IgZGlkIG5vdCBmaW5kIHRoZSBtYXRjaCBuZWVkZWQgZnJvbSB0aGUgJyArXG4gICAgICAgICAgICAncXVlcnknXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGtleXBhcnQgPSBvcHRpb25zLmFycmF5SW5kaWNlc1swXTtcbiAgICAgICAgdXNlZEFycmF5SW5kZXggPSB0cnVlO1xuICAgICAgfSBlbHNlIGlmIChpc051bWVyaWNLZXkoa2V5cGFydCkpIHtcbiAgICAgICAga2V5cGFydCA9IHBhcnNlSW50KGtleXBhcnQpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgaWYgKG9wdGlvbnMubm9DcmVhdGUpIHtcbiAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgTWluaW1vbmdvRXJyb3IoXG4gICAgICAgICAgYGNhbid0IGFwcGVuZCB0byBhcnJheSB1c2luZyBzdHJpbmcgZmllbGQgbmFtZSBbJHtrZXlwYXJ0fV1gXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIGlmIChsYXN0KSB7XG4gICAgICAgIGtleXBhcnRzW2ldID0ga2V5cGFydDsgLy8gaGFuZGxlICdhLjAxJ1xuICAgICAgfVxuXG4gICAgICBpZiAob3B0aW9ucy5ub0NyZWF0ZSAmJiBrZXlwYXJ0ID49IGRvYy5sZW5ndGgpIHtcbiAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgIH1cblxuICAgICAgd2hpbGUgKGRvYy5sZW5ndGggPCBrZXlwYXJ0KSB7XG4gICAgICAgIGRvYy5wdXNoKG51bGwpO1xuICAgICAgfVxuXG4gICAgICBpZiAoIWxhc3QpIHtcbiAgICAgICAgaWYgKGRvYy5sZW5ndGggPT09IGtleXBhcnQpIHtcbiAgICAgICAgICBkb2MucHVzaCh7fSk7XG4gICAgICAgIH0gZWxzZSBpZiAodHlwZW9mIGRvY1trZXlwYXJ0XSAhPT0gJ29iamVjdCcpIHtcbiAgICAgICAgICB0aHJvdyBNaW5pbW9uZ29FcnJvcihcbiAgICAgICAgICAgIGBjYW4ndCBtb2RpZnkgZmllbGQgJyR7a2V5cGFydHNbaSArIDFdfScgb2YgbGlzdCB2YWx1ZSBgICtcbiAgICAgICAgICAgIEpTT04uc3RyaW5naWZ5KGRvY1trZXlwYXJ0XSlcbiAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIGFzc2VydElzVmFsaWRGaWVsZE5hbWUoa2V5cGFydCk7XG5cbiAgICAgIGlmICghKGtleXBhcnQgaW4gZG9jKSkge1xuICAgICAgICBpZiAob3B0aW9ucy5ub0NyZWF0ZSkge1xuICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIWxhc3QpIHtcbiAgICAgICAgICBkb2Nba2V5cGFydF0gPSB7fTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH1cblxuICAgIGlmIChsYXN0KSB7XG4gICAgICByZXR1cm4gZG9jO1xuICAgIH1cblxuICAgIGRvYyA9IGRvY1trZXlwYXJ0XTtcbiAgfVxuXG4gIC8vIG5vdHJlYWNoZWRcbn1cbiIsImltcG9ydCBMb2NhbENvbGxlY3Rpb24gZnJvbSAnLi9sb2NhbF9jb2xsZWN0aW9uLmpzJztcbmltcG9ydCB7XG4gIGNvbXBpbGVEb2N1bWVudFNlbGVjdG9yLFxuICBoYXNPd24sXG4gIG5vdGhpbmdNYXRjaGVyLFxufSBmcm9tICcuL2NvbW1vbi5qcyc7XG5cbmNvbnN0IERlY2ltYWwgPSBQYWNrYWdlWydtb25nby1kZWNpbWFsJ10/LkRlY2ltYWwgfHwgY2xhc3MgRGVjaW1hbFN0dWIge31cblxuLy8gVGhlIG1pbmltb25nbyBzZWxlY3RvciBjb21waWxlciFcblxuLy8gVGVybWlub2xvZ3k6XG4vLyAgLSBhICdzZWxlY3RvcicgaXMgdGhlIEVKU09OIG9iamVjdCByZXByZXNlbnRpbmcgYSBzZWxlY3RvclxuLy8gIC0gYSAnbWF0Y2hlcicgaXMgaXRzIGNvbXBpbGVkIGZvcm0gKHdoZXRoZXIgYSBmdWxsIE1pbmltb25nby5NYXRjaGVyXG4vLyAgICBvYmplY3Qgb3Igb25lIG9mIHRoZSBjb21wb25lbnQgbGFtYmRhcyB0aGF0IG1hdGNoZXMgcGFydHMgb2YgaXQpXG4vLyAgLSBhICdyZXN1bHQgb2JqZWN0JyBpcyBhbiBvYmplY3Qgd2l0aCBhICdyZXN1bHQnIGZpZWxkIGFuZCBtYXliZVxuLy8gICAgZGlzdGFuY2UgYW5kIGFycmF5SW5kaWNlcy5cbi8vICAtIGEgJ2JyYW5jaGVkIHZhbHVlJyBpcyBhbiBvYmplY3Qgd2l0aCBhICd2YWx1ZScgZmllbGQgYW5kIG1heWJlXG4vLyAgICAnZG9udEl0ZXJhdGUnIGFuZCAnYXJyYXlJbmRpY2VzJy5cbi8vICAtIGEgJ2RvY3VtZW50JyBpcyBhIHRvcC1sZXZlbCBvYmplY3QgdGhhdCBjYW4gYmUgc3RvcmVkIGluIGEgY29sbGVjdGlvbi5cbi8vICAtIGEgJ2xvb2t1cCBmdW5jdGlvbicgaXMgYSBmdW5jdGlvbiB0aGF0IHRha2VzIGluIGEgZG9jdW1lbnQgYW5kIHJldHVybnNcbi8vICAgIGFuIGFycmF5IG9mICdicmFuY2hlZCB2YWx1ZXMnLlxuLy8gIC0gYSAnYnJhbmNoZWQgbWF0Y2hlcicgbWFwcyBmcm9tIGFuIGFycmF5IG9mIGJyYW5jaGVkIHZhbHVlcyB0byBhIHJlc3VsdFxuLy8gICAgb2JqZWN0LlxuLy8gIC0gYW4gJ2VsZW1lbnQgbWF0Y2hlcicgbWFwcyBmcm9tIGEgc2luZ2xlIHZhbHVlIHRvIGEgYm9vbC5cblxuLy8gTWFpbiBlbnRyeSBwb2ludC5cbi8vICAgdmFyIG1hdGNoZXIgPSBuZXcgTWluaW1vbmdvLk1hdGNoZXIoe2E6IHskZ3Q6IDV9fSk7XG4vLyAgIGlmIChtYXRjaGVyLmRvY3VtZW50TWF0Y2hlcyh7YTogN30pKSAuLi5cbmV4cG9ydCBkZWZhdWx0IGNsYXNzIE1hdGNoZXIge1xuICBjb25zdHJ1Y3RvcihzZWxlY3RvciwgaXNVcGRhdGUpIHtcbiAgICAvLyBBIHNldCAob2JqZWN0IG1hcHBpbmcgc3RyaW5nIC0+ICopIG9mIGFsbCBvZiB0aGUgZG9jdW1lbnQgcGF0aHMgbG9va2VkXG4gICAgLy8gYXQgYnkgdGhlIHNlbGVjdG9yLiBBbHNvIGluY2x1ZGVzIHRoZSBlbXB0eSBzdHJpbmcgaWYgaXQgbWF5IGxvb2sgYXQgYW55XG4gICAgLy8gcGF0aCAoZWcsICR3aGVyZSkuXG4gICAgdGhpcy5fcGF0aHMgPSB7fTtcbiAgICAvLyBTZXQgdG8gdHJ1ZSBpZiBjb21waWxhdGlvbiBmaW5kcyBhICRuZWFyLlxuICAgIHRoaXMuX2hhc0dlb1F1ZXJ5ID0gZmFsc2U7XG4gICAgLy8gU2V0IHRvIHRydWUgaWYgY29tcGlsYXRpb24gZmluZHMgYSAkd2hlcmUuXG4gICAgdGhpcy5faGFzV2hlcmUgPSBmYWxzZTtcbiAgICAvLyBTZXQgdG8gZmFsc2UgaWYgY29tcGlsYXRpb24gZmluZHMgYW55dGhpbmcgb3RoZXIgdGhhbiBhIHNpbXBsZSBlcXVhbGl0eVxuICAgIC8vIG9yIG9uZSBvciBtb3JlIG9mICckZ3QnLCAnJGd0ZScsICckbHQnLCAnJGx0ZScsICckbmUnLCAnJGluJywgJyRuaW4nIHVzZWRcbiAgICAvLyB3aXRoIHNjYWxhcnMgYXMgb3BlcmFuZHMuXG4gICAgdGhpcy5faXNTaW1wbGUgPSB0cnVlO1xuICAgIC8vIFNldCB0byBhIGR1bW15IGRvY3VtZW50IHdoaWNoIGFsd2F5cyBtYXRjaGVzIHRoaXMgTWF0Y2hlci4gT3Igc2V0IHRvIG51bGxcbiAgICAvLyBpZiBzdWNoIGRvY3VtZW50IGlzIHRvbyBoYXJkIHRvIGZpbmQuXG4gICAgdGhpcy5fbWF0Y2hpbmdEb2N1bWVudCA9IHVuZGVmaW5lZDtcbiAgICAvLyBBIGNsb25lIG9mIHRoZSBvcmlnaW5hbCBzZWxlY3Rvci4gSXQgbWF5IGp1c3QgYmUgYSBmdW5jdGlvbiBpZiB0aGUgdXNlclxuICAgIC8vIHBhc3NlZCBpbiBhIGZ1bmN0aW9uOyBvdGhlcndpc2UgaXMgZGVmaW5pdGVseSBhbiBvYmplY3QgKGVnLCBJRHMgYXJlXG4gICAgLy8gdHJhbnNsYXRlZCBpbnRvIHtfaWQ6IElEfSBmaXJzdC4gVXNlZCBieSBjYW5CZWNvbWVUcnVlQnlNb2RpZmllciBhbmRcbiAgICAvLyBTb3J0ZXIuX3VzZVdpdGhNYXRjaGVyLlxuICAgIHRoaXMuX3NlbGVjdG9yID0gbnVsbDtcbiAgICB0aGlzLl9kb2NNYXRjaGVyID0gdGhpcy5fY29tcGlsZVNlbGVjdG9yKHNlbGVjdG9yKTtcbiAgICAvLyBTZXQgdG8gdHJ1ZSBpZiBzZWxlY3Rpb24gaXMgZG9uZSBmb3IgYW4gdXBkYXRlIG9wZXJhdGlvblxuICAgIC8vIERlZmF1bHQgaXMgZmFsc2VcbiAgICAvLyBVc2VkIGZvciAkbmVhciBhcnJheSB1cGRhdGUgKGlzc3VlICMzNTk5KVxuICAgIHRoaXMuX2lzVXBkYXRlID0gaXNVcGRhdGU7XG4gIH1cblxuICBkb2N1bWVudE1hdGNoZXMoZG9jKSB7XG4gICAgaWYgKGRvYyAhPT0gT2JqZWN0KGRvYykpIHtcbiAgICAgIHRocm93IEVycm9yKCdkb2N1bWVudE1hdGNoZXMgbmVlZHMgYSBkb2N1bWVudCcpO1xuICAgIH1cblxuICAgIHJldHVybiB0aGlzLl9kb2NNYXRjaGVyKGRvYyk7XG4gIH1cblxuICBoYXNHZW9RdWVyeSgpIHtcbiAgICByZXR1cm4gdGhpcy5faGFzR2VvUXVlcnk7XG4gIH1cblxuICBoYXNXaGVyZSgpIHtcbiAgICByZXR1cm4gdGhpcy5faGFzV2hlcmU7XG4gIH1cblxuICBpc1NpbXBsZSgpIHtcbiAgICByZXR1cm4gdGhpcy5faXNTaW1wbGU7XG4gIH1cblxuICAvLyBHaXZlbiBhIHNlbGVjdG9yLCByZXR1cm4gYSBmdW5jdGlvbiB0aGF0IHRha2VzIG9uZSBhcmd1bWVudCwgYVxuICAvLyBkb2N1bWVudC4gSXQgcmV0dXJucyBhIHJlc3VsdCBvYmplY3QuXG4gIF9jb21waWxlU2VsZWN0b3Ioc2VsZWN0b3IpIHtcbiAgICAvLyB5b3UgY2FuIHBhc3MgYSBsaXRlcmFsIGZ1bmN0aW9uIGluc3RlYWQgb2YgYSBzZWxlY3RvclxuICAgIGlmIChzZWxlY3RvciBpbnN0YW5jZW9mIEZ1bmN0aW9uKSB7XG4gICAgICB0aGlzLl9pc1NpbXBsZSA9IGZhbHNlO1xuICAgICAgdGhpcy5fc2VsZWN0b3IgPSBzZWxlY3RvcjtcbiAgICAgIHRoaXMuX3JlY29yZFBhdGhVc2VkKCcnKTtcblxuICAgICAgcmV0dXJuIGRvYyA9PiAoe3Jlc3VsdDogISFzZWxlY3Rvci5jYWxsKGRvYyl9KTtcbiAgICB9XG5cbiAgICAvLyBzaG9ydGhhbmQgLS0gc2NhbGFyIF9pZFxuICAgIGlmIChMb2NhbENvbGxlY3Rpb24uX3NlbGVjdG9ySXNJZChzZWxlY3RvcikpIHtcbiAgICAgIHRoaXMuX3NlbGVjdG9yID0ge19pZDogc2VsZWN0b3J9O1xuICAgICAgdGhpcy5fcmVjb3JkUGF0aFVzZWQoJ19pZCcpO1xuXG4gICAgICByZXR1cm4gZG9jID0+ICh7cmVzdWx0OiBFSlNPTi5lcXVhbHMoZG9jLl9pZCwgc2VsZWN0b3IpfSk7XG4gICAgfVxuXG4gICAgLy8gcHJvdGVjdCBhZ2FpbnN0IGRhbmdlcm91cyBzZWxlY3RvcnMuICBmYWxzZXkgYW5kIHtfaWQ6IGZhbHNleX0gYXJlIGJvdGhcbiAgICAvLyBsaWtlbHkgcHJvZ3JhbW1lciBlcnJvciwgYW5kIG5vdCB3aGF0IHlvdSB3YW50LCBwYXJ0aWN1bGFybHkgZm9yXG4gICAgLy8gZGVzdHJ1Y3RpdmUgb3BlcmF0aW9ucy5cbiAgICBpZiAoIXNlbGVjdG9yIHx8IGhhc093bi5jYWxsKHNlbGVjdG9yLCAnX2lkJykgJiYgIXNlbGVjdG9yLl9pZCkge1xuICAgICAgdGhpcy5faXNTaW1wbGUgPSBmYWxzZTtcbiAgICAgIHJldHVybiBub3RoaW5nTWF0Y2hlcjtcbiAgICB9XG5cbiAgICAvLyBUb3AgbGV2ZWwgY2FuJ3QgYmUgYW4gYXJyYXkgb3IgdHJ1ZSBvciBiaW5hcnkuXG4gICAgaWYgKEFycmF5LmlzQXJyYXkoc2VsZWN0b3IpIHx8XG4gICAgICAgIEVKU09OLmlzQmluYXJ5KHNlbGVjdG9yKSB8fFxuICAgICAgICB0eXBlb2Ygc2VsZWN0b3IgPT09ICdib29sZWFuJykge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIHNlbGVjdG9yOiAke3NlbGVjdG9yfWApO1xuICAgIH1cblxuICAgIHRoaXMuX3NlbGVjdG9yID0gRUpTT04uY2xvbmUoc2VsZWN0b3IpO1xuXG4gICAgcmV0dXJuIGNvbXBpbGVEb2N1bWVudFNlbGVjdG9yKHNlbGVjdG9yLCB0aGlzLCB7aXNSb290OiB0cnVlfSk7XG4gIH1cblxuICAvLyBSZXR1cm5zIGEgbGlzdCBvZiBrZXkgcGF0aHMgdGhlIGdpdmVuIHNlbGVjdG9yIGlzIGxvb2tpbmcgZm9yLiBJdCBpbmNsdWRlc1xuICAvLyB0aGUgZW1wdHkgc3RyaW5nIGlmIHRoZXJlIGlzIGEgJHdoZXJlLlxuICBfZ2V0UGF0aHMoKSB7XG4gICAgcmV0dXJuIE9iamVjdC5rZXlzKHRoaXMuX3BhdGhzKTtcbiAgfVxuXG4gIF9yZWNvcmRQYXRoVXNlZChwYXRoKSB7XG4gICAgdGhpcy5fcGF0aHNbcGF0aF0gPSB0cnVlO1xuICB9XG59XG5cbi8vIGhlbHBlcnMgdXNlZCBieSBjb21waWxlZCBzZWxlY3RvciBjb2RlXG5Mb2NhbENvbGxlY3Rpb24uX2YgPSB7XG4gIC8vIFhYWCBmb3IgX2FsbCBhbmQgX2luLCBjb25zaWRlciBidWlsZGluZyAnaW5xdWVyeScgYXQgY29tcGlsZSB0aW1lLi5cbiAgX3R5cGUodikge1xuICAgIGlmICh0eXBlb2YgdiA9PT0gJ251bWJlcicpIHtcbiAgICAgIHJldHVybiAxO1xuICAgIH1cblxuICAgIGlmICh0eXBlb2YgdiA9PT0gJ3N0cmluZycpIHtcbiAgICAgIHJldHVybiAyO1xuICAgIH1cblxuICAgIGlmICh0eXBlb2YgdiA9PT0gJ2Jvb2xlYW4nKSB7XG4gICAgICByZXR1cm4gODtcbiAgICB9XG5cbiAgICBpZiAoQXJyYXkuaXNBcnJheSh2KSkge1xuICAgICAgcmV0dXJuIDQ7XG4gICAgfVxuXG4gICAgaWYgKHYgPT09IG51bGwpIHtcbiAgICAgIHJldHVybiAxMDtcbiAgICB9XG5cbiAgICAvLyBub3RlIHRoYXQgdHlwZW9mKC94LykgPT09IFwib2JqZWN0XCJcbiAgICBpZiAodiBpbnN0YW5jZW9mIFJlZ0V4cCkge1xuICAgICAgcmV0dXJuIDExO1xuICAgIH1cblxuICAgIGlmICh0eXBlb2YgdiA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgcmV0dXJuIDEzO1xuICAgIH1cblxuICAgIGlmICh2IGluc3RhbmNlb2YgRGF0ZSkge1xuICAgICAgcmV0dXJuIDk7XG4gICAgfVxuXG4gICAgaWYgKEVKU09OLmlzQmluYXJ5KHYpKSB7XG4gICAgICByZXR1cm4gNTtcbiAgICB9XG5cbiAgICBpZiAodiBpbnN0YW5jZW9mIE1vbmdvSUQuT2JqZWN0SUQpIHtcbiAgICAgIHJldHVybiA3O1xuICAgIH1cblxuICAgIGlmICh2IGluc3RhbmNlb2YgRGVjaW1hbCkge1xuICAgICAgcmV0dXJuIDE7XG4gICAgfVxuXG4gICAgLy8gb2JqZWN0XG4gICAgcmV0dXJuIDM7XG5cbiAgICAvLyBYWFggc3VwcG9ydCBzb21lL2FsbCBvZiB0aGVzZTpcbiAgICAvLyAxNCwgc3ltYm9sXG4gICAgLy8gMTUsIGphdmFzY3JpcHQgY29kZSB3aXRoIHNjb3BlXG4gICAgLy8gMTYsIDE4OiAzMi1iaXQvNjQtYml0IGludGVnZXJcbiAgICAvLyAxNywgdGltZXN0YW1wXG4gICAgLy8gMjU1LCBtaW5rZXlcbiAgICAvLyAxMjcsIG1heGtleVxuICB9LFxuXG4gIC8vIGRlZXAgZXF1YWxpdHkgdGVzdDogdXNlIGZvciBsaXRlcmFsIGRvY3VtZW50IGFuZCBhcnJheSBtYXRjaGVzXG4gIF9lcXVhbChhLCBiKSB7XG4gICAgcmV0dXJuIEVKU09OLmVxdWFscyhhLCBiLCB7a2V5T3JkZXJTZW5zaXRpdmU6IHRydWV9KTtcbiAgfSxcblxuICAvLyBtYXBzIGEgdHlwZSBjb2RlIHRvIGEgdmFsdWUgdGhhdCBjYW4gYmUgdXNlZCB0byBzb3J0IHZhbHVlcyBvZiBkaWZmZXJlbnRcbiAgLy8gdHlwZXNcbiAgX3R5cGVvcmRlcih0KSB7XG4gICAgLy8gaHR0cDovL3d3dy5tb25nb2RiLm9yZy9kaXNwbGF5L0RPQ1MvV2hhdCtpcyt0aGUrQ29tcGFyZStPcmRlcitmb3IrQlNPTitUeXBlc1xuICAgIC8vIFhYWCB3aGF0IGlzIHRoZSBjb3JyZWN0IHNvcnQgcG9zaXRpb24gZm9yIEphdmFzY3JpcHQgY29kZT9cbiAgICAvLyAoJzEwMCcgaW4gdGhlIG1hdHJpeCBiZWxvdylcbiAgICAvLyBYWFggbWlua2V5L21heGtleVxuICAgIHJldHVybiBbXG4gICAgICAtMSwgIC8vIChub3QgYSB0eXBlKVxuICAgICAgMSwgICAvLyBudW1iZXJcbiAgICAgIDIsICAgLy8gc3RyaW5nXG4gICAgICAzLCAgIC8vIG9iamVjdFxuICAgICAgNCwgICAvLyBhcnJheVxuICAgICAgNSwgICAvLyBiaW5hcnlcbiAgICAgIC0xLCAgLy8gZGVwcmVjYXRlZFxuICAgICAgNiwgICAvLyBPYmplY3RJRFxuICAgICAgNywgICAvLyBib29sXG4gICAgICA4LCAgIC8vIERhdGVcbiAgICAgIDAsICAgLy8gbnVsbFxuICAgICAgOSwgICAvLyBSZWdFeHBcbiAgICAgIC0xLCAgLy8gZGVwcmVjYXRlZFxuICAgICAgMTAwLCAvLyBKUyBjb2RlXG4gICAgICAyLCAgIC8vIGRlcHJlY2F0ZWQgKHN5bWJvbClcbiAgICAgIDEwMCwgLy8gSlMgY29kZVxuICAgICAgMSwgICAvLyAzMi1iaXQgaW50XG4gICAgICA4LCAgIC8vIE1vbmdvIHRpbWVzdGFtcFxuICAgICAgMSAgICAvLyA2NC1iaXQgaW50XG4gICAgXVt0XTtcbiAgfSxcblxuICAvLyBjb21wYXJlIHR3byB2YWx1ZXMgb2YgdW5rbm93biB0eXBlIGFjY29yZGluZyB0byBCU09OIG9yZGVyaW5nXG4gIC8vIHNlbWFudGljcy4gKGFzIGFuIGV4dGVuc2lvbiwgY29uc2lkZXIgJ3VuZGVmaW5lZCcgdG8gYmUgbGVzcyB0aGFuXG4gIC8vIGFueSBvdGhlciB2YWx1ZS4pIHJldHVybiBuZWdhdGl2ZSBpZiBhIGlzIGxlc3MsIHBvc2l0aXZlIGlmIGIgaXNcbiAgLy8gbGVzcywgb3IgMCBpZiBlcXVhbFxuICBfY21wKGEsIGIpIHtcbiAgICBpZiAoYSA9PT0gdW5kZWZpbmVkKSB7XG4gICAgICByZXR1cm4gYiA9PT0gdW5kZWZpbmVkID8gMCA6IC0xO1xuICAgIH1cblxuICAgIGlmIChiID09PSB1bmRlZmluZWQpIHtcbiAgICAgIHJldHVybiAxO1xuICAgIH1cblxuICAgIGxldCB0YSA9IExvY2FsQ29sbGVjdGlvbi5fZi5fdHlwZShhKTtcbiAgICBsZXQgdGIgPSBMb2NhbENvbGxlY3Rpb24uX2YuX3R5cGUoYik7XG5cbiAgICBjb25zdCBvYSA9IExvY2FsQ29sbGVjdGlvbi5fZi5fdHlwZW9yZGVyKHRhKTtcbiAgICBjb25zdCBvYiA9IExvY2FsQ29sbGVjdGlvbi5fZi5fdHlwZW9yZGVyKHRiKTtcblxuICAgIGlmIChvYSAhPT0gb2IpIHtcbiAgICAgIHJldHVybiBvYSA8IG9iID8gLTEgOiAxO1xuICAgIH1cblxuICAgIC8vIFhYWCBuZWVkIHRvIGltcGxlbWVudCB0aGlzIGlmIHdlIGltcGxlbWVudCBTeW1ib2wgb3IgaW50ZWdlcnMsIG9yXG4gICAgLy8gVGltZXN0YW1wXG4gICAgaWYgKHRhICE9PSB0Yikge1xuICAgICAgdGhyb3cgRXJyb3IoJ01pc3NpbmcgdHlwZSBjb2VyY2lvbiBsb2dpYyBpbiBfY21wJyk7XG4gICAgfVxuXG4gICAgaWYgKHRhID09PSA3KSB7IC8vIE9iamVjdElEXG4gICAgICAvLyBDb252ZXJ0IHRvIHN0cmluZy5cbiAgICAgIHRhID0gdGIgPSAyO1xuICAgICAgYSA9IGEudG9IZXhTdHJpbmcoKTtcbiAgICAgIGIgPSBiLnRvSGV4U3RyaW5nKCk7XG4gICAgfVxuXG4gICAgaWYgKHRhID09PSA5KSB7IC8vIERhdGVcbiAgICAgIC8vIENvbnZlcnQgdG8gbWlsbGlzLlxuICAgICAgdGEgPSB0YiA9IDE7XG4gICAgICBhID0gaXNOYU4oYSkgPyAwIDogYS5nZXRUaW1lKCk7XG4gICAgICBiID0gaXNOYU4oYikgPyAwIDogYi5nZXRUaW1lKCk7XG4gICAgfVxuXG4gICAgaWYgKHRhID09PSAxKSB7IC8vIGRvdWJsZVxuICAgICAgaWYgKGEgaW5zdGFuY2VvZiBEZWNpbWFsKSB7XG4gICAgICAgIHJldHVybiBhLm1pbnVzKGIpLnRvTnVtYmVyKCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZXR1cm4gYSAtIGI7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHRiID09PSAyKSAvLyBzdHJpbmdcbiAgICAgIHJldHVybiBhIDwgYiA/IC0xIDogYSA9PT0gYiA/IDAgOiAxO1xuXG4gICAgaWYgKHRhID09PSAzKSB7IC8vIE9iamVjdFxuICAgICAgLy8gdGhpcyBjb3VsZCBiZSBtdWNoIG1vcmUgZWZmaWNpZW50IGluIHRoZSBleHBlY3RlZCBjYXNlIC4uLlxuICAgICAgY29uc3QgdG9BcnJheSA9IG9iamVjdCA9PiB7XG4gICAgICAgIGNvbnN0IHJlc3VsdCA9IFtdO1xuXG4gICAgICAgIE9iamVjdC5rZXlzKG9iamVjdCkuZm9yRWFjaChrZXkgPT4ge1xuICAgICAgICAgIHJlc3VsdC5wdXNoKGtleSwgb2JqZWN0W2tleV0pO1xuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgfTtcblxuICAgICAgcmV0dXJuIExvY2FsQ29sbGVjdGlvbi5fZi5fY21wKHRvQXJyYXkoYSksIHRvQXJyYXkoYikpO1xuICAgIH1cblxuICAgIGlmICh0YSA9PT0gNCkgeyAvLyBBcnJheVxuICAgICAgZm9yIChsZXQgaSA9IDA7IDsgaSsrKSB7XG4gICAgICAgIGlmIChpID09PSBhLmxlbmd0aCkge1xuICAgICAgICAgIHJldHVybiBpID09PSBiLmxlbmd0aCA/IDAgOiAtMTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpID09PSBiLmxlbmd0aCkge1xuICAgICAgICAgIHJldHVybiAxO1xuICAgICAgICB9XG5cbiAgICAgICAgY29uc3QgcyA9IExvY2FsQ29sbGVjdGlvbi5fZi5fY21wKGFbaV0sIGJbaV0pO1xuICAgICAgICBpZiAocyAhPT0gMCkge1xuICAgICAgICAgIHJldHVybiBzO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHRhID09PSA1KSB7IC8vIGJpbmFyeVxuICAgICAgLy8gU3VycHJpc2luZ2x5LCBhIHNtYWxsIGJpbmFyeSBibG9iIGlzIGFsd2F5cyBsZXNzIHRoYW4gYSBsYXJnZSBvbmUgaW5cbiAgICAgIC8vIE1vbmdvLlxuICAgICAgaWYgKGEubGVuZ3RoICE9PSBiLmxlbmd0aCkge1xuICAgICAgICByZXR1cm4gYS5sZW5ndGggLSBiLmxlbmd0aDtcbiAgICAgIH1cblxuICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBhLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGlmIChhW2ldIDwgYltpXSkge1xuICAgICAgICAgIHJldHVybiAtMTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChhW2ldID4gYltpXSkge1xuICAgICAgICAgIHJldHVybiAxO1xuICAgICAgICB9XG4gICAgICB9XG5cbiAgICAgIHJldHVybiAwO1xuICAgIH1cblxuICAgIGlmICh0YSA9PT0gOCkgeyAvLyBib29sZWFuXG4gICAgICBpZiAoYSkge1xuICAgICAgICByZXR1cm4gYiA/IDAgOiAxO1xuICAgICAgfVxuXG4gICAgICByZXR1cm4gYiA/IC0xIDogMDtcbiAgICB9XG5cbiAgICBpZiAodGEgPT09IDEwKSAvLyBudWxsXG4gICAgICByZXR1cm4gMDtcblxuICAgIGlmICh0YSA9PT0gMTEpIC8vIHJlZ2V4cFxuICAgICAgdGhyb3cgRXJyb3IoJ1NvcnRpbmcgbm90IHN1cHBvcnRlZCBvbiByZWd1bGFyIGV4cHJlc3Npb24nKTsgLy8gWFhYXG5cbiAgICAvLyAxMzogamF2YXNjcmlwdCBjb2RlXG4gICAgLy8gMTQ6IHN5bWJvbFxuICAgIC8vIDE1OiBqYXZhc2NyaXB0IGNvZGUgd2l0aCBzY29wZVxuICAgIC8vIDE2OiAzMi1iaXQgaW50ZWdlclxuICAgIC8vIDE3OiB0aW1lc3RhbXBcbiAgICAvLyAxODogNjQtYml0IGludGVnZXJcbiAgICAvLyAyNTU6IG1pbmtleVxuICAgIC8vIDEyNzogbWF4a2V5XG4gICAgaWYgKHRhID09PSAxMykgLy8gamF2YXNjcmlwdCBjb2RlXG4gICAgICB0aHJvdyBFcnJvcignU29ydGluZyBub3Qgc3VwcG9ydGVkIG9uIEphdmFzY3JpcHQgY29kZScpOyAvLyBYWFhcblxuICAgIHRocm93IEVycm9yKCdVbmtub3duIHR5cGUgdG8gc29ydCcpO1xuICB9LFxufTtcbiIsImltcG9ydCBMb2NhbENvbGxlY3Rpb25fIGZyb20gJy4vbG9jYWxfY29sbGVjdGlvbi5qcyc7XG5pbXBvcnQgTWF0Y2hlciBmcm9tICcuL21hdGNoZXIuanMnO1xuaW1wb3J0IFNvcnRlciBmcm9tICcuL3NvcnRlci5qcyc7XG5cbkxvY2FsQ29sbGVjdGlvbiA9IExvY2FsQ29sbGVjdGlvbl87XG5NaW5pbW9uZ28gPSB7XG4gICAgTG9jYWxDb2xsZWN0aW9uOiBMb2NhbENvbGxlY3Rpb25fLFxuICAgIE1hdGNoZXIsXG4gICAgU29ydGVyXG59O1xuIiwiLy8gT2JzZXJ2ZUhhbmRsZTogdGhlIHJldHVybiB2YWx1ZSBvZiBhIGxpdmUgcXVlcnkuXG5leHBvcnQgZGVmYXVsdCBjbGFzcyBPYnNlcnZlSGFuZGxlIHt9XG4iLCJpbXBvcnQge1xuICBFTEVNRU5UX09QRVJBVE9SUyxcbiAgZXF1YWxpdHlFbGVtZW50TWF0Y2hlcixcbiAgZXhwYW5kQXJyYXlzSW5CcmFuY2hlcyxcbiAgaGFzT3duLFxuICBpc09wZXJhdG9yT2JqZWN0LFxuICBtYWtlTG9va3VwRnVuY3Rpb24sXG4gIHJlZ2V4cEVsZW1lbnRNYXRjaGVyLFxufSBmcm9tICcuL2NvbW1vbi5qcyc7XG5cbi8vIEdpdmUgYSBzb3J0IHNwZWMsIHdoaWNoIGNhbiBiZSBpbiBhbnkgb2YgdGhlc2UgZm9ybXM6XG4vLyAgIHtcImtleTFcIjogMSwgXCJrZXkyXCI6IC0xfVxuLy8gICBbW1wia2V5MVwiLCBcImFzY1wiXSwgW1wia2V5MlwiLCBcImRlc2NcIl1dXG4vLyAgIFtcImtleTFcIiwgW1wia2V5MlwiLCBcImRlc2NcIl1dXG4vL1xuLy8gKC4uIHdpdGggdGhlIGZpcnN0IGZvcm0gYmVpbmcgZGVwZW5kZW50IG9uIHRoZSBrZXkgZW51bWVyYXRpb25cbi8vIGJlaGF2aW9yIG9mIHlvdXIgamF2YXNjcmlwdCBWTSwgd2hpY2ggdXN1YWxseSBkb2VzIHdoYXQgeW91IG1lYW4gaW5cbi8vIHRoaXMgY2FzZSBpZiB0aGUga2V5IG5hbWVzIGRvbid0IGxvb2sgbGlrZSBpbnRlZ2VycyAuLilcbi8vXG4vLyByZXR1cm4gYSBmdW5jdGlvbiB0aGF0IHRha2VzIHR3byBvYmplY3RzLCBhbmQgcmV0dXJucyAtMSBpZiB0aGVcbi8vIGZpcnN0IG9iamVjdCBjb21lcyBmaXJzdCBpbiBvcmRlciwgMSBpZiB0aGUgc2Vjb25kIG9iamVjdCBjb21lc1xuLy8gZmlyc3QsIG9yIDAgaWYgbmVpdGhlciBvYmplY3QgY29tZXMgYmVmb3JlIHRoZSBvdGhlci5cblxuZXhwb3J0IGRlZmF1bHQgY2xhc3MgU29ydGVyIHtcbiAgY29uc3RydWN0b3Ioc3BlYykge1xuICAgIHRoaXMuX3NvcnRTcGVjUGFydHMgPSBbXTtcbiAgICB0aGlzLl9zb3J0RnVuY3Rpb24gPSBudWxsO1xuXG4gICAgY29uc3QgYWRkU3BlY1BhcnQgPSAocGF0aCwgYXNjZW5kaW5nKSA9PiB7XG4gICAgICBpZiAoIXBhdGgpIHtcbiAgICAgICAgdGhyb3cgRXJyb3IoJ3NvcnQga2V5cyBtdXN0IGJlIG5vbi1lbXB0eScpO1xuICAgICAgfVxuXG4gICAgICBpZiAocGF0aC5jaGFyQXQoMCkgPT09ICckJykge1xuICAgICAgICB0aHJvdyBFcnJvcihgdW5zdXBwb3J0ZWQgc29ydCBrZXk6ICR7cGF0aH1gKTtcbiAgICAgIH1cblxuICAgICAgdGhpcy5fc29ydFNwZWNQYXJ0cy5wdXNoKHtcbiAgICAgICAgYXNjZW5kaW5nLFxuICAgICAgICBsb29rdXA6IG1ha2VMb29rdXBGdW5jdGlvbihwYXRoLCB7Zm9yU29ydDogdHJ1ZX0pLFxuICAgICAgICBwYXRoXG4gICAgICB9KTtcbiAgICB9O1xuXG4gICAgaWYgKHNwZWMgaW5zdGFuY2VvZiBBcnJheSkge1xuICAgICAgc3BlYy5mb3JFYWNoKGVsZW1lbnQgPT4ge1xuICAgICAgICBpZiAodHlwZW9mIGVsZW1lbnQgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgYWRkU3BlY1BhcnQoZWxlbWVudCwgdHJ1ZSk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgYWRkU3BlY1BhcnQoZWxlbWVudFswXSwgZWxlbWVudFsxXSAhPT0gJ2Rlc2MnKTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfSBlbHNlIGlmICh0eXBlb2Ygc3BlYyA9PT0gJ29iamVjdCcpIHtcbiAgICAgIE9iamVjdC5rZXlzKHNwZWMpLmZvckVhY2goa2V5ID0+IHtcbiAgICAgICAgYWRkU3BlY1BhcnQoa2V5LCBzcGVjW2tleV0gPj0gMCk7XG4gICAgICB9KTtcbiAgICB9IGVsc2UgaWYgKHR5cGVvZiBzcGVjID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICB0aGlzLl9zb3J0RnVuY3Rpb24gPSBzcGVjO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aHJvdyBFcnJvcihgQmFkIHNvcnQgc3BlY2lmaWNhdGlvbjogJHtKU09OLnN0cmluZ2lmeShzcGVjKX1gKTtcbiAgICB9XG5cbiAgICAvLyBJZiBhIGZ1bmN0aW9uIGlzIHNwZWNpZmllZCBmb3Igc29ydGluZywgd2Ugc2tpcCB0aGUgcmVzdC5cbiAgICBpZiAodGhpcy5fc29ydEZ1bmN0aW9uKSB7XG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgLy8gVG8gaW1wbGVtZW50IGFmZmVjdGVkQnlNb2RpZmllciwgd2UgcGlnZ3ktYmFjayBvbiB0b3Agb2YgTWF0Y2hlcidzXG4gICAgLy8gYWZmZWN0ZWRCeU1vZGlmaWVyIGNvZGU7IHdlIGNyZWF0ZSBhIHNlbGVjdG9yIHRoYXQgaXMgYWZmZWN0ZWQgYnkgdGhlXG4gICAgLy8gc2FtZSBtb2RpZmllcnMgYXMgdGhpcyBzb3J0IG9yZGVyLiBUaGlzIGlzIG9ubHkgaW1wbGVtZW50ZWQgb24gdGhlXG4gICAgLy8gc2VydmVyLlxuICAgIGlmICh0aGlzLmFmZmVjdGVkQnlNb2RpZmllcikge1xuICAgICAgY29uc3Qgc2VsZWN0b3IgPSB7fTtcblxuICAgICAgdGhpcy5fc29ydFNwZWNQYXJ0cy5mb3JFYWNoKHNwZWMgPT4ge1xuICAgICAgICBzZWxlY3RvcltzcGVjLnBhdGhdID0gMTtcbiAgICAgIH0pO1xuXG4gICAgICB0aGlzLl9zZWxlY3RvckZvckFmZmVjdGVkQnlNb2RpZmllciA9IG5ldyBNaW5pbW9uZ28uTWF0Y2hlcihzZWxlY3Rvcik7XG4gICAgfVxuXG4gICAgdGhpcy5fa2V5Q29tcGFyYXRvciA9IGNvbXBvc2VDb21wYXJhdG9ycyhcbiAgICAgIHRoaXMuX3NvcnRTcGVjUGFydHMubWFwKChzcGVjLCBpKSA9PiB0aGlzLl9rZXlGaWVsZENvbXBhcmF0b3IoaSkpXG4gICAgKTtcbiAgfVxuXG4gIGdldENvbXBhcmF0b3Iob3B0aW9ucykge1xuICAgIC8vIElmIHNvcnQgaXMgc3BlY2lmaWVkIG9yIGhhdmUgbm8gZGlzdGFuY2VzLCBqdXN0IHVzZSB0aGUgY29tcGFyYXRvciBmcm9tXG4gICAgLy8gdGhlIHNvdXJjZSBzcGVjaWZpY2F0aW9uICh3aGljaCBkZWZhdWx0cyB0byBcImV2ZXJ5dGhpbmcgaXMgZXF1YWxcIi5cbiAgICAvLyBpc3N1ZSAjMzU5OVxuICAgIC8vIGh0dHBzOi8vZG9jcy5tb25nb2RiLmNvbS9tYW51YWwvcmVmZXJlbmNlL29wZXJhdG9yL3F1ZXJ5L25lYXIvI3NvcnQtb3BlcmF0aW9uXG4gICAgLy8gc29ydCBlZmZlY3RpdmVseSBvdmVycmlkZXMgJG5lYXJcbiAgICBpZiAodGhpcy5fc29ydFNwZWNQYXJ0cy5sZW5ndGggfHwgIW9wdGlvbnMgfHwgIW9wdGlvbnMuZGlzdGFuY2VzKSB7XG4gICAgICByZXR1cm4gdGhpcy5fZ2V0QmFzZUNvbXBhcmF0b3IoKTtcbiAgICB9XG5cbiAgICBjb25zdCBkaXN0YW5jZXMgPSBvcHRpb25zLmRpc3RhbmNlcztcblxuICAgIC8vIFJldHVybiBhIGNvbXBhcmF0b3Igd2hpY2ggY29tcGFyZXMgdXNpbmcgJG5lYXIgZGlzdGFuY2VzLlxuICAgIHJldHVybiAoYSwgYikgPT4ge1xuICAgICAgaWYgKCFkaXN0YW5jZXMuaGFzKGEuX2lkKSkge1xuICAgICAgICB0aHJvdyBFcnJvcihgTWlzc2luZyBkaXN0YW5jZSBmb3IgJHthLl9pZH1gKTtcbiAgICAgIH1cblxuICAgICAgaWYgKCFkaXN0YW5jZXMuaGFzKGIuX2lkKSkge1xuICAgICAgICB0aHJvdyBFcnJvcihgTWlzc2luZyBkaXN0YW5jZSBmb3IgJHtiLl9pZH1gKTtcbiAgICAgIH1cblxuICAgICAgcmV0dXJuIGRpc3RhbmNlcy5nZXQoYS5faWQpIC0gZGlzdGFuY2VzLmdldChiLl9pZCk7XG4gICAgfTtcbiAgfVxuXG4gIC8vIFRha2VzIGluIHR3byBrZXlzOiBhcnJheXMgd2hvc2UgbGVuZ3RocyBtYXRjaCB0aGUgbnVtYmVyIG9mIHNwZWNcbiAgLy8gcGFydHMuIFJldHVybnMgbmVnYXRpdmUsIDAsIG9yIHBvc2l0aXZlIGJhc2VkIG9uIHVzaW5nIHRoZSBzb3J0IHNwZWMgdG9cbiAgLy8gY29tcGFyZSBmaWVsZHMuXG4gIF9jb21wYXJlS2V5cyhrZXkxLCBrZXkyKSB7XG4gICAgaWYgKGtleTEubGVuZ3RoICE9PSB0aGlzLl9zb3J0U3BlY1BhcnRzLmxlbmd0aCB8fFxuICAgICAgICBrZXkyLmxlbmd0aCAhPT0gdGhpcy5fc29ydFNwZWNQYXJ0cy5sZW5ndGgpIHtcbiAgICAgIHRocm93IEVycm9yKCdLZXkgaGFzIHdyb25nIGxlbmd0aCcpO1xuICAgIH1cblxuICAgIHJldHVybiB0aGlzLl9rZXlDb21wYXJhdG9yKGtleTEsIGtleTIpO1xuICB9XG5cbiAgLy8gSXRlcmF0ZXMgb3ZlciBlYWNoIHBvc3NpYmxlIFwia2V5XCIgZnJvbSBkb2MgKGllLCBvdmVyIGVhY2ggYnJhbmNoKSwgY2FsbGluZ1xuICAvLyAnY2InIHdpdGggdGhlIGtleS5cbiAgX2dlbmVyYXRlS2V5c0Zyb21Eb2MoZG9jLCBjYikge1xuICAgIGlmICh0aGlzLl9zb3J0U3BlY1BhcnRzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKCdjYW5cXCd0IGdlbmVyYXRlIGtleXMgd2l0aG91dCBhIHNwZWMnKTtcbiAgICB9XG5cbiAgICBjb25zdCBwYXRoRnJvbUluZGljZXMgPSBpbmRpY2VzID0+IGAke2luZGljZXMuam9pbignLCcpfSxgO1xuXG4gICAgbGV0IGtub3duUGF0aHMgPSBudWxsO1xuXG4gICAgLy8gbWFwcyBpbmRleCAtPiAoeycnIC0+IHZhbHVlfSBvciB7cGF0aCAtPiB2YWx1ZX0pXG4gICAgY29uc3QgdmFsdWVzQnlJbmRleEFuZFBhdGggPSB0aGlzLl9zb3J0U3BlY1BhcnRzLm1hcChzcGVjID0+IHtcbiAgICAgIC8vIEV4cGFuZCBhbnkgbGVhZiBhcnJheXMgdGhhdCB3ZSBmaW5kLCBhbmQgaWdub3JlIHRob3NlIGFycmF5c1xuICAgICAgLy8gdGhlbXNlbHZlcy4gIChXZSBuZXZlciBzb3J0IGJhc2VkIG9uIGFuIGFycmF5IGl0c2VsZi4pXG4gICAgICBsZXQgYnJhbmNoZXMgPSBleHBhbmRBcnJheXNJbkJyYW5jaGVzKHNwZWMubG9va3VwKGRvYyksIHRydWUpO1xuXG4gICAgICAvLyBJZiB0aGVyZSBhcmUgbm8gdmFsdWVzIGZvciBhIGtleSAoZWcsIGtleSBnb2VzIHRvIGFuIGVtcHR5IGFycmF5KSxcbiAgICAgIC8vIHByZXRlbmQgd2UgZm91bmQgb25lIHVuZGVmaW5lZCB2YWx1ZS5cbiAgICAgIGlmICghYnJhbmNoZXMubGVuZ3RoKSB7XG4gICAgICAgIGJyYW5jaGVzID0gW3sgdmFsdWU6IHZvaWQgMCB9XTtcbiAgICAgIH1cblxuICAgICAgY29uc3QgZWxlbWVudCA9IE9iamVjdC5jcmVhdGUobnVsbCk7XG4gICAgICBsZXQgdXNlZFBhdGhzID0gZmFsc2U7XG5cbiAgICAgIGJyYW5jaGVzLmZvckVhY2goYnJhbmNoID0+IHtcbiAgICAgICAgaWYgKCFicmFuY2guYXJyYXlJbmRpY2VzKSB7XG4gICAgICAgICAgLy8gSWYgdGhlcmUgYXJlIG5vIGFycmF5IGluZGljZXMgZm9yIGEgYnJhbmNoLCB0aGVuIGl0IG11c3QgYmUgdGhlXG4gICAgICAgICAgLy8gb25seSBicmFuY2gsIGJlY2F1c2UgdGhlIG9ubHkgdGhpbmcgdGhhdCBwcm9kdWNlcyBtdWx0aXBsZSBicmFuY2hlc1xuICAgICAgICAgIC8vIGlzIHRoZSB1c2Ugb2YgYXJyYXlzLlxuICAgICAgICAgIGlmIChicmFuY2hlcy5sZW5ndGggPiAxKSB7XG4gICAgICAgICAgICB0aHJvdyBFcnJvcignbXVsdGlwbGUgYnJhbmNoZXMgYnV0IG5vIGFycmF5IHVzZWQ/Jyk7XG4gICAgICAgICAgfVxuXG4gICAgICAgICAgZWxlbWVudFsnJ10gPSBicmFuY2gudmFsdWU7XG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgdXNlZFBhdGhzID0gdHJ1ZTtcblxuICAgICAgICBjb25zdCBwYXRoID0gcGF0aEZyb21JbmRpY2VzKGJyYW5jaC5hcnJheUluZGljZXMpO1xuXG4gICAgICAgIGlmIChoYXNPd24uY2FsbChlbGVtZW50LCBwYXRoKSkge1xuICAgICAgICAgIHRocm93IEVycm9yKGBkdXBsaWNhdGUgcGF0aDogJHtwYXRofWApO1xuICAgICAgICB9XG5cbiAgICAgICAgZWxlbWVudFtwYXRoXSA9IGJyYW5jaC52YWx1ZTtcblxuICAgICAgICAvLyBJZiB0d28gc29ydCBmaWVsZHMgYm90aCBnbyBpbnRvIGFycmF5cywgdGhleSBoYXZlIHRvIGdvIGludG8gdGhlXG4gICAgICAgIC8vIGV4YWN0IHNhbWUgYXJyYXlzIGFuZCB3ZSBoYXZlIHRvIGZpbmQgdGhlIHNhbWUgcGF0aHMuICBUaGlzIGlzXG4gICAgICAgIC8vIHJvdWdobHkgdGhlIHNhbWUgY29uZGl0aW9uIHRoYXQgbWFrZXMgTW9uZ29EQiB0aHJvdyB0aGlzIHN0cmFuZ2VcbiAgICAgICAgLy8gZXJyb3IgbWVzc2FnZS4gIGVnLCB0aGUgbWFpbiB0aGluZyBpcyB0aGF0IGlmIHNvcnQgc3BlYyBpcyB7YTogMSxcbiAgICAgICAgLy8gYjoxfSB0aGVuIGEgYW5kIGIgY2Fubm90IGJvdGggYmUgYXJyYXlzLlxuICAgICAgICAvL1xuICAgICAgICAvLyAoSW4gTW9uZ29EQiBpdCBzZWVtcyB0byBiZSBPSyB0byBoYXZlIHthOiAxLCAnYS54LnknOiAxfSB3aGVyZSAnYSdcbiAgICAgICAgLy8gYW5kICdhLngueScgYXJlIGJvdGggYXJyYXlzLCBidXQgd2UgZG9uJ3QgYWxsb3cgdGhpcyBmb3Igbm93LlxuICAgICAgICAvLyAjTmVzdGVkQXJyYXlTb3J0XG4gICAgICAgIC8vIFhYWCBhY2hpZXZlIGZ1bGwgY29tcGF0aWJpbGl0eSBoZXJlXG4gICAgICAgIGlmIChrbm93blBhdGhzICYmICFoYXNPd24uY2FsbChrbm93blBhdGhzLCBwYXRoKSkge1xuICAgICAgICAgIHRocm93IEVycm9yKCdjYW5ub3QgaW5kZXggcGFyYWxsZWwgYXJyYXlzJyk7XG4gICAgICAgIH1cbiAgICAgIH0pO1xuXG4gICAgICBpZiAoa25vd25QYXRocykge1xuICAgICAgICAvLyBTaW1pbGFybHkgdG8gYWJvdmUsIHBhdGhzIG11c3QgbWF0Y2ggZXZlcnl3aGVyZSwgdW5sZXNzIHRoaXMgaXMgYVxuICAgICAgICAvLyBub24tYXJyYXkgZmllbGQuXG4gICAgICAgIGlmICghaGFzT3duLmNhbGwoZWxlbWVudCwgJycpICYmXG4gICAgICAgICAgICBPYmplY3Qua2V5cyhrbm93blBhdGhzKS5sZW5ndGggIT09IE9iamVjdC5rZXlzKGVsZW1lbnQpLmxlbmd0aCkge1xuICAgICAgICAgIHRocm93IEVycm9yKCdjYW5ub3QgaW5kZXggcGFyYWxsZWwgYXJyYXlzIScpO1xuICAgICAgICB9XG4gICAgICB9IGVsc2UgaWYgKHVzZWRQYXRocykge1xuICAgICAgICBrbm93blBhdGhzID0ge307XG5cbiAgICAgICAgT2JqZWN0LmtleXMoZWxlbWVudCkuZm9yRWFjaChwYXRoID0+IHtcbiAgICAgICAgICBrbm93blBhdGhzW3BhdGhdID0gdHJ1ZTtcbiAgICAgICAgfSk7XG4gICAgICB9XG5cbiAgICAgIHJldHVybiBlbGVtZW50O1xuICAgIH0pO1xuXG4gICAgaWYgKCFrbm93blBhdGhzKSB7XG4gICAgICAvLyBFYXN5IGNhc2U6IG5vIHVzZSBvZiBhcnJheXMuXG4gICAgICBjb25zdCBzb2xlS2V5ID0gdmFsdWVzQnlJbmRleEFuZFBhdGgubWFwKHZhbHVlcyA9PiB7XG4gICAgICAgIGlmICghaGFzT3duLmNhbGwodmFsdWVzLCAnJykpIHtcbiAgICAgICAgICB0aHJvdyBFcnJvcignbm8gdmFsdWUgaW4gc29sZSBrZXkgY2FzZT8nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB2YWx1ZXNbJyddO1xuICAgICAgfSk7XG5cbiAgICAgIGNiKHNvbGVLZXkpO1xuXG4gICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgT2JqZWN0LmtleXMoa25vd25QYXRocykuZm9yRWFjaChwYXRoID0+IHtcbiAgICAgIGNvbnN0IGtleSA9IHZhbHVlc0J5SW5kZXhBbmRQYXRoLm1hcCh2YWx1ZXMgPT4ge1xuICAgICAgICBpZiAoaGFzT3duLmNhbGwodmFsdWVzLCAnJykpIHtcbiAgICAgICAgICByZXR1cm4gdmFsdWVzWycnXTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghaGFzT3duLmNhbGwodmFsdWVzLCBwYXRoKSkge1xuICAgICAgICAgIHRocm93IEVycm9yKCdtaXNzaW5nIHBhdGg/Jyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdmFsdWVzW3BhdGhdO1xuICAgICAgfSk7XG5cbiAgICAgIGNiKGtleSk7XG4gICAgfSk7XG4gIH1cblxuICAvLyBSZXR1cm5zIGEgY29tcGFyYXRvciB0aGF0IHJlcHJlc2VudHMgdGhlIHNvcnQgc3BlY2lmaWNhdGlvbiAoYnV0IG5vdFxuICAvLyBpbmNsdWRpbmcgYSBwb3NzaWJsZSBnZW9xdWVyeSBkaXN0YW5jZSB0aWUtYnJlYWtlcikuXG4gIF9nZXRCYXNlQ29tcGFyYXRvcigpIHtcbiAgICBpZiAodGhpcy5fc29ydEZ1bmN0aW9uKSB7XG4gICAgICByZXR1cm4gdGhpcy5fc29ydEZ1bmN0aW9uO1xuICAgIH1cblxuICAgIC8vIElmIHdlJ3JlIG9ubHkgc29ydGluZyBvbiBnZW9xdWVyeSBkaXN0YW5jZSBhbmQgbm8gc3BlY3MsIGp1c3Qgc2F5XG4gICAgLy8gZXZlcnl0aGluZyBpcyBlcXVhbC5cbiAgICBpZiAoIXRoaXMuX3NvcnRTcGVjUGFydHMubGVuZ3RoKSB7XG4gICAgICByZXR1cm4gKGRvYzEsIGRvYzIpID0+IDA7XG4gICAgfVxuXG4gICAgcmV0dXJuIChkb2MxLCBkb2MyKSA9PiB7XG4gICAgICBjb25zdCBrZXkxID0gdGhpcy5fZ2V0TWluS2V5RnJvbURvYyhkb2MxKTtcbiAgICAgIGNvbnN0IGtleTIgPSB0aGlzLl9nZXRNaW5LZXlGcm9tRG9jKGRvYzIpO1xuICAgICAgcmV0dXJuIHRoaXMuX2NvbXBhcmVLZXlzKGtleTEsIGtleTIpO1xuICAgIH07XG4gIH1cblxuICAvLyBGaW5kcyB0aGUgbWluaW11bSBrZXkgZnJvbSB0aGUgZG9jLCBhY2NvcmRpbmcgdG8gdGhlIHNvcnQgc3BlY3MuICAoV2Ugc2F5XG4gIC8vIFwibWluaW11bVwiIGhlcmUgYnV0IHRoaXMgaXMgd2l0aCByZXNwZWN0IHRvIHRoZSBzb3J0IHNwZWMsIHNvIFwiZGVzY2VuZGluZ1wiXG4gIC8vIHNvcnQgZmllbGRzIG1lYW4gd2UncmUgZmluZGluZyB0aGUgbWF4IGZvciB0aGF0IGZpZWxkLilcbiAgLy9cbiAgLy8gTm90ZSB0aGF0IHRoaXMgaXMgTk9UIFwiZmluZCB0aGUgbWluaW11bSB2YWx1ZSBvZiB0aGUgZmlyc3QgZmllbGQsIHRoZVxuICAvLyBtaW5pbXVtIHZhbHVlIG9mIHRoZSBzZWNvbmQgZmllbGQsIGV0Y1wiLi4uIGl0J3MgXCJjaG9vc2UgdGhlXG4gIC8vIGxleGljb2dyYXBoaWNhbGx5IG1pbmltdW0gdmFsdWUgb2YgdGhlIGtleSB2ZWN0b3IsIGFsbG93aW5nIG9ubHkga2V5cyB3aGljaFxuICAvLyB5b3UgY2FuIGZpbmQgYWxvbmcgdGhlIHNhbWUgcGF0aHNcIi4gIGllLCBmb3IgYSBkb2Mge2E6IFt7eDogMCwgeTogNX0sIHt4OlxuICAvLyAxLCB5OiAzfV19IHdpdGggc29ydCBzcGVjIHsnYS54JzogMSwgJ2EueSc6IDF9LCB0aGUgb25seSBrZXlzIGFyZSBbMCw1XSBhbmRcbiAgLy8gWzEsM10sIGFuZCB0aGUgbWluaW11bSBrZXkgaXMgWzAsNV07IG5vdGFibHksIFswLDNdIGlzIE5PVCBhIGtleS5cbiAgX2dldE1pbktleUZyb21Eb2MoZG9jKSB7XG4gICAgbGV0IG1pbktleSA9IG51bGw7XG5cbiAgICB0aGlzLl9nZW5lcmF0ZUtleXNGcm9tRG9jKGRvYywga2V5ID0+IHtcbiAgICAgIGlmIChtaW5LZXkgPT09IG51bGwpIHtcbiAgICAgICAgbWluS2V5ID0ga2V5O1xuICAgICAgICByZXR1cm47XG4gICAgICB9XG5cbiAgICAgIGlmICh0aGlzLl9jb21wYXJlS2V5cyhrZXksIG1pbktleSkgPCAwKSB7XG4gICAgICAgIG1pbktleSA9IGtleTtcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIHJldHVybiBtaW5LZXk7XG4gIH1cblxuICBfZ2V0UGF0aHMoKSB7XG4gICAgcmV0dXJuIHRoaXMuX3NvcnRTcGVjUGFydHMubWFwKHBhcnQgPT4gcGFydC5wYXRoKTtcbiAgfVxuXG4gIC8vIEdpdmVuIGFuIGluZGV4ICdpJywgcmV0dXJucyBhIGNvbXBhcmF0b3IgdGhhdCBjb21wYXJlcyB0d28ga2V5IGFycmF5cyBiYXNlZFxuICAvLyBvbiBmaWVsZCAnaScuXG4gIF9rZXlGaWVsZENvbXBhcmF0b3IoaSkge1xuICAgIGNvbnN0IGludmVydCA9ICF0aGlzLl9zb3J0U3BlY1BhcnRzW2ldLmFzY2VuZGluZztcblxuICAgIHJldHVybiAoa2V5MSwga2V5MikgPT4ge1xuICAgICAgY29uc3QgY29tcGFyZSA9IExvY2FsQ29sbGVjdGlvbi5fZi5fY21wKGtleTFbaV0sIGtleTJbaV0pO1xuICAgICAgcmV0dXJuIGludmVydCA/IC1jb21wYXJlIDogY29tcGFyZTtcbiAgICB9O1xuICB9XG59XG5cbi8vIEdpdmVuIGFuIGFycmF5IG9mIGNvbXBhcmF0b3JzXG4vLyAoZnVuY3Rpb25zIChhLGIpLT4obmVnYXRpdmUgb3IgcG9zaXRpdmUgb3IgemVybykpLCByZXR1cm5zIGEgc2luZ2xlXG4vLyBjb21wYXJhdG9yIHdoaWNoIHVzZXMgZWFjaCBjb21wYXJhdG9yIGluIG9yZGVyIGFuZCByZXR1cm5zIHRoZSBmaXJzdFxuLy8gbm9uLXplcm8gdmFsdWUuXG5mdW5jdGlvbiBjb21wb3NlQ29tcGFyYXRvcnMoY29tcGFyYXRvckFycmF5KSB7XG4gIHJldHVybiAoYSwgYikgPT4ge1xuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgY29tcGFyYXRvckFycmF5Lmxlbmd0aDsgKytpKSB7XG4gICAgICBjb25zdCBjb21wYXJlID0gY29tcGFyYXRvckFycmF5W2ldKGEsIGIpO1xuICAgICAgaWYgKGNvbXBhcmUgIT09IDApIHtcbiAgICAgICAgcmV0dXJuIGNvbXBhcmU7XG4gICAgICB9XG4gICAgfVxuXG4gICAgcmV0dXJuIDA7XG4gIH07XG59XG4iXX0=
