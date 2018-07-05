/*
* Licensed to the Apache Software Foundation (ASF) under one
* or more contributor license agreements.  See the NOTICE file
* distributed with this work for additional information
* regarding copyright ownership.  The ASF licenses this file
* to you under the Apache License, Version 2.0 (the
* "License"); you may not use this file except in compliance
* with the License.  You may obtain a copy of the License at
*
*   http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing,
* software distributed under the License is distributed on an
* "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
* KIND, either express or implied.  See the License for the
* specific language governing permissions and limitations
* under the License.
*/
import { __DEV__ } from '../../config';
import * as zrUtil from 'zrender/src/core/util';
import * as graphic from '../../util/graphic';
import * as modelUtil from '../../util/model';
import * as brushHelper from './brushHelper';
var each = zrUtil.each;
var indexOf = zrUtil.indexOf;
var curry = zrUtil.curry;
var COORD_CONVERTS = ['dataToPoint', 'pointToData']; // FIXME
// how to genarialize to more coordinate systems.

var INCLUDE_FINDER_MAIN_TYPES = ['grid', 'xAxis', 'yAxis', 'geo', 'graph', 'polar', 'radiusAxis', 'angleAxis', 'bmap'];
/**
 * [option in constructor]:
 * {
 *     Index/Id/Name of geo, xAxis, yAxis, grid: See util/model#parseFinder.
 * }
 *
 *
 * [targetInfo]:
 *
 * There can be multiple axes in a single targetInfo. Consider the case
 * of `grid` component, a targetInfo represents a grid which contains one or more
 * cartesian and one or more axes. And consider the case of parallel system,
 * which has multiple axes in a coordinate system.
 * Can be {
 *     panelId: ...,
 *     coordSys: <a representitive cartesian in grid (first cartesian by default)>,
 *     coordSyses: all cartesians.
 *     gridModel: <grid component>
 *     xAxes: correspond to coordSyses on index
 *     yAxes: correspond to coordSyses on index
 * }
 * or {
 *     panelId: ...,
 *     coordSys: <geo coord sys>
 *     coordSyses: [<geo coord sys>]
 *     geoModel: <geo component>
 * }
 *
 *
 * [panelOpt]:
 *
 * Make from targetInfo. Input to BrushController.
 * {
 *     panelId: ...,
 *     rect: ...
 * }
 *
 *
 * [area]:
 *
 * Generated by BrushController or user input.
 * {
 *     panelId: Used to locate coordInfo directly. If user inpput, no panelId.
 *     brushType: determine how to convert to/from coord('rect' or 'polygon' or 'lineX/Y').
 *     Index/Id/Name of geo, xAxis, yAxis, grid: See util/model#parseFinder.
 *     range: pixel range.
 *     coordRange: representitive coord range (the first one of coordRanges).
 *     coordRanges: <Array> coord ranges, used in multiple cartesian in one grid.
 * }
 */

/**
 * @param {Object} option contains Index/Id/Name of xAxis/yAxis/geo/grid
 *        Each can be {number|Array.<number>}. like: {xAxisIndex: [3, 4]}
 * @param {module:echarts/model/Global} ecModel
 * @param {Object} [opt]
 * @param {Array.<string>} [opt.include] include coordinate system types.
 */

function BrushTargetManager(option, ecModel, opt) {
  /**
   * @private
   * @type {Array.<Object>}
   */
  var targetInfoList = this._targetInfoList = [];
  var info = {};
  var foundCpts = parseFinder(ecModel, option);
  each(targetInfoBuilders, function (builder, type) {
    if (!opt || !opt.include || indexOf(opt.include, type) >= 0) {
      builder(foundCpts, targetInfoList, info);
    }
  });
}

var proto = BrushTargetManager.prototype;

proto.setOutputRanges = function (areas, ecModel) {
  this.matchOutputRanges(areas, ecModel, function (area, coordRange, coordSys) {
    (area.coordRanges || (area.coordRanges = [])).push(coordRange); // area.coordRange is the first of area.coordRanges

    if (!area.coordRange) {
      area.coordRange = coordRange; // In 'category' axis, coord to pixel is not reversible, so we can not
      // rebuild range by coordRange accrately, which may bring trouble when
      // brushing only one item. So we use __rangeOffset to rebuilding range
      // by coordRange. And this it only used in brush component so it is no
      // need to be adapted to coordRanges.

      var result = coordConvert[area.brushType](0, coordSys, coordRange);
      area.__rangeOffset = {
        offset: diffProcessor[area.brushType](result.values, area.range, [1, 1]),
        xyMinMax: result.xyMinMax
      };
    }
  });
};

proto.matchOutputRanges = function (areas, ecModel, cb) {
  each(areas, function (area) {
    var targetInfo = this.findTargetInfo(area, ecModel);

    if (targetInfo && targetInfo !== true) {
      zrUtil.each(targetInfo.coordSyses, function (coordSys) {
        var result = coordConvert[area.brushType](1, coordSys, area.range);
        cb(area, result.values, coordSys, ecModel);
      });
    }
  }, this);
};

proto.setInputRanges = function (areas, ecModel) {
  each(areas, function (area) {
    var targetInfo = this.findTargetInfo(area, ecModel);
    area.range = area.range || []; // convert coordRange to global range and set panelId.

    if (targetInfo && targetInfo !== true) {
      area.panelId = targetInfo.panelId; // (1) area.range shoule always be calculate from coordRange but does
      // not keep its original value, for the sake of the dataZoom scenario,
      // where area.coordRange remains unchanged but area.range may be changed.
      // (2) Only support converting one coordRange to pixel range in brush
      // component. So do not consider `coordRanges`.
      // (3) About __rangeOffset, see comment above.

      var result = coordConvert[area.brushType](0, targetInfo.coordSys, area.coordRange);
      var rangeOffset = area.__rangeOffset;
      area.range = rangeOffset ? diffProcessor[area.brushType](result.values, rangeOffset.offset, getScales(result.xyMinMax, rangeOffset.xyMinMax)) : result.values;
    }
  }, this);
};

proto.makePanelOpts = function (api, getDefaultBrushType) {
  return zrUtil.map(this._targetInfoList, function (targetInfo) {
    var rect = targetInfo.getPanelRect();
    return {
      panelId: targetInfo.panelId,
      defaultBrushType: getDefaultBrushType && getDefaultBrushType(targetInfo),
      clipPath: brushHelper.makeRectPanelClipPath(rect),
      isTargetByCursor: brushHelper.makeRectIsTargetByCursor(rect, api, targetInfo.coordSysModel),
      getLinearBrushOtherExtent: brushHelper.makeLinearBrushOtherExtent(rect)
    };
  });
};

proto.controlSeries = function (area, seriesModel, ecModel) {
  // Check whether area is bound in coord, and series do not belong to that coord.
  // If do not do this check, some brush (like lineX) will controll all axes.
  var targetInfo = this.findTargetInfo(area, ecModel);
  return targetInfo === true || targetInfo && indexOf(targetInfo.coordSyses, seriesModel.coordinateSystem) >= 0;
};
/**
 * If return Object, a coord found.
 * If reutrn true, global found.
 * Otherwise nothing found.
 *
 * @param {Object} area
 * @param {Array} targetInfoList
 * @return {Object|boolean}
 */


proto.findTargetInfo = function (area, ecModel) {
  var targetInfoList = this._targetInfoList;
  var foundCpts = parseFinder(ecModel, area);

  for (var i = 0; i < targetInfoList.length; i++) {
    var targetInfo = targetInfoList[i];
    var areaPanelId = area.panelId;

    if (areaPanelId) {
      if (targetInfo.panelId === areaPanelId) {
        return targetInfo;
      }
    } else {
      for (var i = 0; i < targetInfoMatchers.length; i++) {
        if (targetInfoMatchers[i](foundCpts, targetInfo)) {
          return targetInfo;
        }
      }
    }
  }

  return true;
};

function formatMinMax(minMax) {
  minMax[0] > minMax[1] && minMax.reverse();
  return minMax;
}

function parseFinder(ecModel, option) {
  return modelUtil.parseFinder(ecModel, option, {
    includeMainTypes: INCLUDE_FINDER_MAIN_TYPES
  });
}

var targetInfoBuilders = {
  grid: function (foundCpts, targetInfoList) {
    var xAxisModels = foundCpts.xAxisModels;
    var yAxisModels = foundCpts.yAxisModels;
    var gridModels = foundCpts.gridModels; // Remove duplicated.

    var gridModelMap = zrUtil.createHashMap();
    var xAxesHas = {};
    var yAxesHas = {};

    if (!xAxisModels && !yAxisModels && !gridModels) {
      return;
    }

    each(xAxisModels, function (axisModel) {
      var gridModel = axisModel.axis.grid.model;
      gridModelMap.set(gridModel.id, gridModel);
      xAxesHas[gridModel.id] = true;
    });
    each(yAxisModels, function (axisModel) {
      var gridModel = axisModel.axis.grid.model;
      gridModelMap.set(gridModel.id, gridModel);
      yAxesHas[gridModel.id] = true;
    });
    each(gridModels, function (gridModel) {
      gridModelMap.set(gridModel.id, gridModel);
      xAxesHas[gridModel.id] = true;
      yAxesHas[gridModel.id] = true;
    });
    gridModelMap.each(function (gridModel) {
      var grid = gridModel.coordinateSystem;
      var cartesians = [];
      each(grid.getCartesians(), function (cartesian, index) {
        if (indexOf(xAxisModels, cartesian.getAxis('x').model) >= 0 || indexOf(yAxisModels, cartesian.getAxis('y').model) >= 0) {
          cartesians.push(cartesian);
        }
      });
      targetInfoList.push({
        panelId: 'grid--' + gridModel.id,
        gridModel: gridModel,
        coordSysModel: gridModel,
        // Use the first one as the representitive coordSys.
        coordSys: cartesians[0],
        coordSyses: cartesians,
        getPanelRect: panelRectBuilder.grid,
        xAxisDeclared: xAxesHas[gridModel.id],
        yAxisDeclared: yAxesHas[gridModel.id]
      });
    });
  },
  geo: function (foundCpts, targetInfoList) {
    each(foundCpts.geoModels, function (geoModel) {
      var coordSys = geoModel.coordinateSystem;
      targetInfoList.push({
        panelId: 'geo--' + geoModel.id,
        geoModel: geoModel,
        coordSysModel: geoModel,
        coordSys: coordSys,
        coordSyses: [coordSys],
        getPanelRect: panelRectBuilder.geo
      });
    });
  }
};
var targetInfoMatchers = [// grid
function (foundCpts, targetInfo) {
  var xAxisModel = foundCpts.xAxisModel;
  var yAxisModel = foundCpts.yAxisModel;
  var gridModel = foundCpts.gridModel;
  !gridModel && xAxisModel && (gridModel = xAxisModel.axis.grid.model);
  !gridModel && yAxisModel && (gridModel = yAxisModel.axis.grid.model);
  return gridModel && gridModel === targetInfo.gridModel;
}, // geo
function (foundCpts, targetInfo) {
  var geoModel = foundCpts.geoModel;
  return geoModel && geoModel === targetInfo.geoModel;
}];
var panelRectBuilder = {
  grid: function () {
    // grid is not Transformable.
    return this.coordSys.grid.getRect().clone();
  },
  geo: function () {
    var coordSys = this.coordSys;
    var rect = coordSys.getBoundingRect().clone(); // geo roam and zoom transform

    rect.applyTransform(graphic.getTransform(coordSys));
    return rect;
  }
};
var coordConvert = {
  lineX: curry(axisConvert, 0),
  lineY: curry(axisConvert, 1),
  rect: function (to, coordSys, rangeOrCoordRange) {
    var xminymin = coordSys[COORD_CONVERTS[to]]([rangeOrCoordRange[0][0], rangeOrCoordRange[1][0]]);
    var xmaxymax = coordSys[COORD_CONVERTS[to]]([rangeOrCoordRange[0][1], rangeOrCoordRange[1][1]]);
    var values = [formatMinMax([xminymin[0], xmaxymax[0]]), formatMinMax([xminymin[1], xmaxymax[1]])];
    return {
      values: values,
      xyMinMax: values
    };
  },
  polygon: function (to, coordSys, rangeOrCoordRange) {
    var xyMinMax = [[Infinity, -Infinity], [Infinity, -Infinity]];
    var values = zrUtil.map(rangeOrCoordRange, function (item) {
      var p = coordSys[COORD_CONVERTS[to]](item);
      xyMinMax[0][0] = Math.min(xyMinMax[0][0], p[0]);
      xyMinMax[1][0] = Math.min(xyMinMax[1][0], p[1]);
      xyMinMax[0][1] = Math.max(xyMinMax[0][1], p[0]);
      xyMinMax[1][1] = Math.max(xyMinMax[1][1], p[1]);
      return p;
    });
    return {
      values: values,
      xyMinMax: xyMinMax
    };
  }
};

function axisConvert(axisNameIndex, to, coordSys, rangeOrCoordRange) {
  var axis = coordSys.getAxis(['x', 'y'][axisNameIndex]);
  var values = formatMinMax(zrUtil.map([0, 1], function (i) {
    return to ? axis.coordToData(axis.toLocalCoord(rangeOrCoordRange[i])) : axis.toGlobalCoord(axis.dataToCoord(rangeOrCoordRange[i]));
  }));
  var xyMinMax = [];
  xyMinMax[axisNameIndex] = values;
  xyMinMax[1 - axisNameIndex] = [NaN, NaN];
  return {
    values: values,
    xyMinMax: xyMinMax
  };
}

var diffProcessor = {
  lineX: curry(axisDiffProcessor, 0),
  lineY: curry(axisDiffProcessor, 1),
  rect: function (values, refer, scales) {
    return [[values[0][0] - scales[0] * refer[0][0], values[0][1] - scales[0] * refer[0][1]], [values[1][0] - scales[1] * refer[1][0], values[1][1] - scales[1] * refer[1][1]]];
  },
  polygon: function (values, refer, scales) {
    return zrUtil.map(values, function (item, idx) {
      return [item[0] - scales[0] * refer[idx][0], item[1] - scales[1] * refer[idx][1]];
    });
  }
};

function axisDiffProcessor(axisNameIndex, values, refer, scales) {
  return [values[0] - scales[axisNameIndex] * refer[0], values[1] - scales[axisNameIndex] * refer[1]];
} // We have to process scale caused by dataZoom manually,
// although it might be not accurate.


function getScales(xyMinMaxCurr, xyMinMaxOrigin) {
  var sizeCurr = getSize(xyMinMaxCurr);
  var sizeOrigin = getSize(xyMinMaxOrigin);
  var scales = [sizeCurr[0] / sizeOrigin[0], sizeCurr[1] / sizeOrigin[1]];
  isNaN(scales[0]) && (scales[0] = 1);
  isNaN(scales[1]) && (scales[1] = 1);
  return scales;
}

function getSize(xyMinMax) {
  return xyMinMax ? [xyMinMax[0][1] - xyMinMax[0][0], xyMinMax[1][1] - xyMinMax[1][0]] : [NaN, NaN];
}

export default BrushTargetManager;