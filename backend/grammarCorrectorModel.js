/**
 * Grammar Corrector - Using Hugging Face Model
 * Uses @xenova/transformers with pszemraj/grammar-synthesis-small
 * T5-based text2text-generation model for grammar correction
 * 
 * Model: https://huggingface.co/pszemraj/grammar-synthesis-small
 * Size: 77M parameters - lightweight and fast
 */

import { pipeline, AutoModelForSeq2SeqLM, AutoTokenizer } from '@xenova/transformers';
import fetch from 'node-fetch';

// CRITICAL FIX: Patch Tensor._subarray to handle undefined data bug
// This fixes the "Cannot use 'in' operator to search for 'subarray' in undefined" error
// The bug is in seq2seqStartBeams when it iterates over tokens with undefined data
let tensorPatched = false;

async function patchTensorSubarray() {
  if (tensorPatched) return;
  
  try {
    // Import Tensor from the transformers library
    const transformersModule = await import('@xenova/transformers');
    const Tensor = transformersModule.Tensor;
    
    if (Tensor && Tensor.prototype) {
      // CRITICAL PATCH: Also need to patch ONNX Runtime's Tensor constructor if it exists
      // The Tensor constructor might be clearing the data property
      try {
        // Try multiple possible ONNX import paths
        let onnxCommon = null;
        try {
          onnxCommon = await import('onnxruntime-common');
        } catch (e1) {
          try {
            const onnxNode = await import('onnxruntime-node');
            onnxCommon = onnxNode;
          } catch (e2) {
            console.log('[GrammarCorrector] ONNX Runtime not found in onnxruntime-common or onnxruntime-node');
          }
        }
        
        if (onnxCommon && onnxCommon.Tensor) {
          const OriginalTensor = onnxCommon.Tensor;
          onnxCommon.Tensor = class extends OriginalTensor {
            constructor(type, data, dims, location = 'cpu') {
              super(type, data, dims, location);
              // Ensure dataLocation is always a string (location is a getter, read-only)
              if (this.dataLocation && typeof this.dataLocation !== 'string') {
                this.dataLocation = String(this.dataLocation);
              }
              // CRITICAL: Ensure data is preserved by setting it directly on the instance
              // Object.assign in transformers will overwrite our data, so we need to set it here
              if (data) {
                // Force set data property
                try {
                  Object.defineProperty(this, 'data', {
                    value: data,
                    writable: true,
                    enumerable: true,
                    configurable: true
                  });
                } catch (e) {
                  // If defineProperty fails, try direct assignment
                  console.warn('[GrammarCorrector] defineProperty failed, trying direct assignment:', e.message);
                  this.data = data;
                }
              }
            }
          };
          console.log('[GrammarCorrector] ✅ Patched ONNX Runtime Tensor constructor');
        }
      } catch (e) {
        // ONNX Runtime might not be importable this way
        console.log('[GrammarCorrector] ONNX Runtime Tensor not patchable:', e.message);
      }
      
      // Patch _subarray method (first bug)
      if (Tensor.prototype._subarray) {
        const originalSubarray = Tensor.prototype._subarray;
        
        Tensor.prototype._subarray = function(index, iterSize, iterDims) {
          // Check if data exists before using 'in' operator (this is the bug fix)
          if (!this.data || this.data === undefined || this.data === null) {
            // CRITICAL: Try to use cpuData first if available, rather than creating empty tensor
            if (this.cpuData && this.cpuData.length > 0) {
              // Calculate the slice range
              const endIndex = Math.min(index + iterSize, this.cpuData.length);
              const sliceLength = Math.max(0, endIndex - index);
              
              // Create slice from cpuData
              let sliceData;
              const tensorType = this.type || 'float32';
              
              if (tensorType === 'int64' && this.cpuData instanceof BigInt64Array) {
                sliceData = this.cpuData.slice(index, endIndex);
              } else if (this.cpuData.slice) {
                sliceData = this.cpuData.slice(index, endIndex);
              } else {
                // Fallback: convert to array and slice
                const arr = Array.from(this.cpuData).slice(index, endIndex);
                if (tensorType === 'int64') {
                  sliceData = new BigInt64Array(arr.map(x => BigInt(x)));
                } else {
                  sliceData = new (this.cpuData.constructor || Float32Array)(arr);
                }
              }
              
              // Calculate dims from slice
              const dims = iterDims || [1, sliceLength];
              return new Tensor(tensorType, sliceData, dims);
            }
            
            // Fallback: Return a minimal valid tensor to avoid crash
            // CRITICAL: Preserve the tensor type - use BigInt64Array for int64, etc.
            // CRITICAL: Calculate size from iterDims to match Tensor constructor requirements
            const tensorType = this.type || 'float32';
            const dims = iterDims || (this.dims ? [this.dims[0], iterSize || 1] : [1, 1]);
            const requiredSize = dims.length > 0 ? dims.reduce((a, b) => a * b, 1) : (iterSize || 1);
            
            let emptyData;
            if (tensorType === 'int64') {
              emptyData = new BigInt64Array(requiredSize);
            } else if (this.cpuData && this.cpuData.constructor) {
              // Try to use the same constructor as cpuData
              emptyData = new this.cpuData.constructor(requiredSize);
            } else {
              // Fallback based on type
              if (tensorType === 'float32') {
                emptyData = new Float32Array(requiredSize);
              } else if (tensorType === 'int32') {
                emptyData = new Int32Array(requiredSize);
              } else {
                emptyData = new Float32Array(requiredSize);
              }
            }
            
            return new Tensor(tensorType, emptyData, dims);
          }
          // Call original method if data exists - it should preserve the data type
          const result = originalSubarray.call(this, index, iterSize, iterDims);
          
          // CRITICAL: Ensure the result tensor has the correct data type for int64
          // ONNX Runtime requires BigInt64Array for int64 tensors
          if (this.type === 'int64' && result) {
            if (result.data && !(result.data instanceof BigInt64Array)) {
              // If the result doesn't have BigInt64Array, fix it
              const bigIntData = Array.from(result.data).map(x => BigInt(x));
              result.data = new BigInt64Array(bigIntData);
              // Also set cpuData
              if (!result.cpuData) {
                result.cpuData = result.data;
              }
              console.log('[GrammarCorrector] Fixed _subarray result to use BigInt64Array');
            } else if (!result.data && this.cpuData instanceof BigInt64Array) {
              // If result has no data but we have cpuData, create a slice
              try {
                const slice = this.cpuData.subarray(index, index + iterSize);
                result.data = slice;
                result.cpuData = slice;
              } catch (e) {
                console.warn('[GrammarCorrector] Could not create subarray from cpuData:', e.message);
              }
            }
            
            // Ensure dataLocation is set for ONNX Runtime (location is a getter, read-only)
            if (!result.dataLocation) {
              result.dataLocation = this.dataLocation || 'cpu';
            }
          }
          
          return result;
        };
      }
      
      // Patch indexOf method (second bug - "Cannot read properties of undefined (reading 'length')")
      if (Tensor.prototype.indexOf) {
        const originalIndexOf = Tensor.prototype.indexOf;
        
        Tensor.prototype.indexOf = function(searchElement, fromIndex) {
          // Check if data exists before accessing length
          if (!this.data || this.data === undefined || this.data === null) {
            console.warn('[GrammarCorrector] Tensor.indexOf called with undefined data, returning -1');
            return -1; // Standard indexOf behavior when not found
          }
          // Ensure data has length property
          if (typeof this.data.length === 'undefined') {
            console.warn('[GrammarCorrector] Tensor data has no length property, returning -1');
            return -1;
          }
          // Call original method if data is valid
          return originalIndexOf.call(this, searchElement, fromIndex);
        };
      }
      
      // CRITICAL PATCH: Add location getter to transformers Tensor
      // Object.assign doesn't copy getter properties from ONNXTensor
      if (!Tensor.prototype.hasOwnProperty('location')) {
        Object.defineProperty(Tensor.prototype, 'location', {
          get: function() {
            return this.dataLocation;
          },
          enumerable: false,
          configurable: true
        });
        console.log('[GrammarCorrector] ✅ Added location getter to Tensor');
      }
      
      tensorPatched = true;
      console.log('[GrammarCorrector] ✅ Patched Tensor._subarray, Tensor.indexOf, and added location getter');
    }
  } catch (error) {
    console.warn('[GrammarCorrector] Could not patch Tensor methods:', error.message);
  }
}

export class GrammarCorrectorModel {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.language = options.language || 'en-US';
    // Use Xenova version which is pre-converted for Transformers.js
    this.modelName = options.modelName || process.env.GRAMMAR_MODEL || 'Xenova/grammar-synthesis-small';
    this.originalModelName = 'pszemraj/grammar-synthesis-small'; // For API fallback
    
    // Pipeline will be initialized lazily
    this.pipeline = null;
    this.initializing = false;
    this.initPromise = null;
    this.useAPI = false; // Fallback to API if local model fails
    this.apiUrl = `https://api-inference.huggingface.co/models/${this.originalModelName}`;
    this.hfToken = process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN;
    
    // Status tracking
    this.status = 'not_initialized'; // not_initialized, downloading, loading, ready, failed
    this.initStartTime = null;
    this.downloadProgress = null;
  }
  
  /**
   * Get current status of the grammar corrector
   */
  getStatus() {
    return {
      status: this.status,
      pipeline: !!this.pipeline,
      initializing: this.initializing,
      useAPI: this.useAPI,
      modelName: this.modelName,
      elapsed: this.initStartTime ? Date.now() - this.initStartTime : null
    };
  }

  /**
   * Initialize the model pipeline
   */
  async init() {
    if (this.pipeline) return;
    if (this.initializing) return this.initPromise;
    if (!this.enabled) return;

    // Apply Tensor patch early to prevent bugs
    await patchTensorSubarray();

    this.initializing = true;
    this.status = 'downloading';
    this.initStartTime = Date.now();
    
    // Start periodic status updates
    const statusInterval = setInterval(() => {
      if (!this.initializing) {
        clearInterval(statusInterval);
        return;
      }
      const elapsed = Math.floor((Date.now() - this.initStartTime) / 1000);
      console.log(`[GrammarCorrector] ⏳ Status: ${this.status.toUpperCase()} (${elapsed}s elapsed) - Still loading...`);
    }, 5000); // Update every 5 seconds
    
    this.initPromise = (async () => {
      try {
        console.log(`[GrammarCorrector] ⏳ Initializing grammar correction model: ${this.modelName}...`);
        console.log('[GrammarCorrector] 📦 Status: DOWNLOADING - Model files (~77MB)...');
        console.log('[GrammarCorrector] 💡 This is a one-time download. Subsequent starts will be faster.');
        
        try {
          // Create text2text-generation pipeline
          // Try Xenova version first (pre-converted for Transformers.js)
          // If that fails, try the original pszemraj version
          let modelToTry = this.modelName;
          
            try {
              console.log(`[GrammarCorrector] 📥 Loading model: ${modelToTry}...`);
              this.status = 'loading';
              console.log('[GrammarCorrector] 📋 Status: LOADING - Processing model files...');
              
              // Skip standard pipeline by default - it has a bug in seq2seqStartBeams
              const skipStandardPipeline = process.env.GRAMMAR_USE_STANDARD_PIPELINE !== 'true';
              
              if (!skipStandardPipeline) {
              try {
                  const rawPipeline = await pipeline(
                  'text2text-generation',
                  modelToTry,
                  {
                    quantized: true,
                  }
                );
                  
                  // Wrap the pipeline to catch internal errors (like 'subarray' errors)
                  // If we get the subarray error, we'll switch to direct model loading
                  this.pipeline = async (text, options = {}) => {
                    try {
                      // Ensure text is a string (not pre-tokenized)
                      if (typeof text !== 'string') {
                        throw new Error('Input must be a string');
                      }
                      
                      // Normalize options to avoid beam search bugs
                      const safeOptions = {
                        max_new_tokens: options.max_new_tokens || 256,
                        do_sample: false, // Force greedy decoding
                        ...(options.num_beams === 1 ? {} : { num_beams: 1 }), // Force single beam
                      };
                      
                      return await rawPipeline(text, safeOptions);
                    } catch (error) {
                      // Catch 'subarray' errors from within the library
                      if (error && error.message && error.message.includes('subarray')) {
                        console.error('[GrammarCorrector] ⚠️ Standard pipeline has seq2seqStartBeams bug - switching to direct model loading');
                        console.error('[GrammarCorrector] Error: Cannot use \'in\' operator to search for \'subarray\' in undefined');
                        
                        // Mark that pipeline is broken and trigger switch to direct loading
                        this._pipelineHasBug = true;
                        this.pipeline = null; // Clear the broken pipeline
                        this.status = 'loading'; // Mark as loading so we'll retry
                        
                        // Return original text for this call
                        return [{ generated_text: text }];
                      }
                      throw error;
                    }
                  };
                  
                console.log(`[GrammarCorrector] ✅ Pipeline loaded successfully: ${modelToTry}`);
                this.status = 'ready';
                this.useAPI = false;
                  this._pipelineHasBug = false; // Reset bug flag if pipeline loads successfully
              } catch (pipelineError) {
              // If pipeline fails, try loading model and tokenizer directly
                  // Use Xenova model for direct loading (has ONNX files), not pszemraj
                  if (skipStandardPipeline || this._pipelineHasBug || modelToTry === 'pszemraj/grammar-synthesis-small' || modelToTry === this.originalModelName) {
                    console.log(`[GrammarCorrector] 🔄 Pipeline failed or skipped, trying direct model loading...`);
                console.log('[GrammarCorrector] 📋 Status: LOADING - Loading tokenizer and model separately...');
                    
                    // Use Xenova model for direct loading - it has the ONNX format needed
                    const directModelName = modelToTry === 'Xenova/grammar-synthesis-small' ? modelToTry : 'Xenova/grammar-synthesis-small';
                    console.log(`[GrammarCorrector] 🔄 Using ${directModelName} for direct loading (ONNX format)`);
                
                // Load tokenizer and model separately
                console.log('[GrammarCorrector] 🔤 Loading tokenizer...');
                    const tokenizer = await Promise.race([
                      AutoTokenizer.from_pretrained(directModelName),
                      new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Tokenizer load timeout after 60s')), 60000)
                      )
                    ]);
                console.log('[GrammarCorrector] 🧠 Loading model weights...');
                    const model = await Promise.race([
                      AutoModelForSeq2SeqLM.from_pretrained(directModelName, {
                        quantized: true, // Use quantized for faster loading
                      }),
                      new Promise((_, reject) => 
                        setTimeout(() => reject(new Error('Model load timeout after 120s')), 120000)
                      )
                    ]);
                
                // Create a pipeline-like wrapper
                this.pipeline = async (text, options = {}) => {
                      try {
                        // Tokenize with proper options for @xenova/transformers
                        // Note: @xenova/transformers uses different options than Python transformers
                  const inputs = await tokenizer(text);
                        
                        // Validate inputs structure
                        if (!inputs) {
                          throw new Error('Tokenizer returned undefined');
                        }
                        
                        // CRITICAL FIX: Ensure Tensor objects have data property set from cpuData
                        // The tokenizer returns tensors with cpuData but data is undefined
                        // We need to set data from cpuData before using them
                        if (inputs && inputs.input_ids && inputs.input_ids.cpuData && inputs.input_ids.data === undefined) {
                          inputs.input_ids.data = inputs.input_ids.cpuData;
                        }
                        if (inputs && inputs.attention_mask && inputs.attention_mask.cpuData && inputs.attention_mask.data === undefined) {
                          inputs.attention_mask.data = inputs.attention_mask.cpuData;
                        }
                        
                        // Handle different tokenizer output formats from @xenova/transformers
                        let inputIds;
                        if (inputs && inputs.input_ids) {
                          const inputIdsValue = inputs.input_ids;
                          // Use the tensor directly (we've already fixed the data property)
                          // Make sure it's actually a Tensor, not an object wrapper
                          if (inputIdsValue && typeof inputIdsValue === 'object') {
                            inputIds = inputIdsValue;
                          } else {
                            inputIds = inputIdsValue;
                          }
                        } else if (Array.isArray(inputs)) {
                          inputIds = inputs[0] || inputs;
                        } else if (inputs && inputs.data) {
                          inputIds = inputs.data;
                        } else {
                          inputIds = inputs;
                        }
                        
                        if (!inputIds) {
                          throw new Error('Could not extract input_ids from tokenizer output');
                        }
                        
                        // Generate with model
                        const outputs = await model.generate(inputIds, {
                    max_new_tokens: options.max_new_tokens || 256,
                    num_beams: options.num_beams || 1,
                    early_stopping: options.early_stopping !== false,
                    do_sample: options.do_sample || false,
                    temperature: options.temperature || 1.0,
                  });
                        
                        // Handle different output formats from model.generate
                        // model.generate typically returns the token IDs directly or wrapped in an object
                        let outputIds = null;
                        
                        try {
                          // Try to extract token IDs from various possible formats
                          if (Array.isArray(outputs)) {
                            // If it's an array, take the first element (sequence)
                            outputIds = outputs[0];
                            // If first element is also an array or has data, extract further
                            if (outputIds && typeof outputIds === 'object' && outputIds.data) {
                              outputIds = outputIds.data;
                            }
                          } else if (outputs && typeof outputs === 'object') {
                            // Check for common property names
                            if (outputs.sequences !== undefined && outputs.sequences !== null) {
                              const seq = Array.isArray(outputs.sequences) ? outputs.sequences[0] : outputs.sequences;
                              if (seq && seq.data !== undefined) {
                                outputIds = seq.data;
                              } else if (seq) {
                                outputIds = seq;
                              }
                            } else if (outputs.input_ids !== undefined && outputs.input_ids !== null) {
                              const ids = outputs.input_ids;
                              if (ids.data !== undefined) {
                                outputIds = ids.data;
                              } else {
                                outputIds = ids;
                              }
                            } else if (outputs[0] !== undefined) {
                              outputIds = outputs[0];
                            } else if (outputs.data !== undefined) {
                              outputIds = outputs.data;
                            } else {
                              // Use the object itself - might be a Tensor
                              outputIds = outputs;
                            }
                          } else {
                            outputIds = outputs;
                          }
                          
                          // Convert to plain array if needed to avoid 'subarray' errors
                          if (outputIds && typeof outputIds === 'object' && outputIds !== null) {
                            // If it's a TypedArray or similar, convert to regular array
                            if (!Array.isArray(outputIds)) {
                              // Check if it has length property (TypedArray-like)
                              if ('length' in outputIds && typeof outputIds.length === 'number') {
                                try {
                                  // Convert TypedArray to regular array
                                  outputIds = Array.from(outputIds);
                                } catch (convertError) {
                                  // If conversion fails, try using subarray (but safely)
                                  if ('subarray' in outputIds && typeof outputIds.subarray === 'function') {
                                    outputIds = outputIds.subarray(0);
                                  }
                                }
                              }
                            }
                          }
                          
                          if (!outputIds || (Array.isArray(outputIds) && outputIds.length === 0)) {
                            throw new Error('Could not extract valid token IDs from model.generate output');
                          }
                          
                          // tokenizer.decode expects an array or tensor-like object
                          // Pass it directly - tokenizer should handle the conversion
                          const decoded = await tokenizer.decode(outputIds, { skip_special_tokens: true });
                  return [{ generated_text: decoded }];
                        } catch (decodeError) {
                          // If decode fails, log the error and the output format for debugging
                          console.error('[GrammarCorrector] Decode error:', decodeError.message);
                          console.error('[GrammarCorrector] Output type:', typeof outputs);
                          console.error('[GrammarCorrector] Output isArray:', Array.isArray(outputs));
                          if (outputs && typeof outputs === 'object') {
                            console.error('[GrammarCorrector] Output keys:', Object.keys(outputs));
                          }
                          throw decodeError;
                        }
                      } catch (error) {
                        console.error('[GrammarCorrector] Pipeline wrapper error:', error.message);
                        console.error('[GrammarCorrector] Error stack:', error.stack);
                        throw error;
                      }
                    };
                    
                    console.log(`[GrammarCorrector] ✅ Direct model loaded: ${directModelName}`);
                this.status = 'ready';
                this.useAPI = false;
              } else {
                throw pipelineError;
              }
                }
              } else {
                // Standard pipeline was skipped - go directly to model loading
                // Use Xenova model which has ONNX files
                const directModelName = 'Xenova/grammar-synthesis-small';
                console.log(`[GrammarCorrector] 🔄 Pipeline skipped, using direct model loading with ${directModelName}...`);
                console.log('[GrammarCorrector] 📋 Status: LOADING - Loading tokenizer and model separately...');
                
                // Load tokenizer and model separately
                console.log('[GrammarCorrector] 🔤 Loading tokenizer...');
                const tokenizer = await Promise.race([
                  AutoTokenizer.from_pretrained(directModelName),
                  new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Tokenizer load timeout after 60s')), 60000)
                  )
                ]);
                console.log('[GrammarCorrector] 🧠 Loading model weights...');
                const model = await Promise.race([
                  AutoModelForSeq2SeqLM.from_pretrained(directModelName, {
                    quantized: true, // Use quantized for faster loading
                  }),
                  new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Model load timeout after 120s')), 120000)
                  )
                ]);
                
                // Create a pipeline-like wrapper
                this.pipeline = async (text, options = {}) => {
                  try {
                    // Tokenize with proper options for @xenova/transformers
                    // Note: @xenova/transformers uses different options than Python transformers
                  const inputs = await tokenizer(text);
                    
                    // Validate inputs structure
                    if (!inputs) {
                      throw new Error('Tokenizer returned undefined');
                    }
                    
                    // CRITICAL FIX: Work directly with inputs.input_ids Tensor
                    // The Tensor has cpuData but data is undefined - we MUST fix this BEFORE doing anything else
                    // ONNX Runtime requires the data property to be set
                    const { Tensor } = await import('@xenova/transformers');
                    
                    // Get the input_ids Tensor directly - don't extract data yet
                    let inputIdsTensor = null;
                    if (inputs && inputs.input_ids) {
                      inputIdsTensor = inputs.input_ids;
                    } else if (Array.isArray(inputs)) {
                      inputIdsTensor = inputs[0];
                    } else {
                      inputIdsTensor = inputs;
                    }
                    
                    if (!inputIdsTensor) {
                      throw new Error('Could not get input_ids from tokenizer output');
                    }
                    
                    // CRITICAL FIX: Fix BOTH input_ids AND attention_mask
                    // model.generate() uses both tensors, and both need data/location properties
                    const fixTensor = (tensor, name = 'tensor') => {
                      console.log(`[GrammarCorrector] 🔧 Fixing ${name}...`);
                      if (!(tensor instanceof Tensor)) {
                        console.log(`[GrammarCorrector] ⚠️ ${name} is not a Tensor instance, returning as-is`);
                        return tensor;
                      }
                      
                      console.log(`[GrammarCorrector] 📊 ${name} - dims:`, tensor.dims, 'type:', tensor.type, 'has cpuData:', !!tensor.cpuData, 'has data:', !!tensor.data);
                      
                      const dims = tensor.dims || [1, tensor.size || (tensor.cpuData?.length || tensor.data?.length || 0)];
                      const type = tensor.type || 'int64';
                      let arrayData = null;
                      
                      // Extract data from cpuData or data
                      if (tensor.cpuData) {
                        if (tensor.cpuData instanceof BigInt64Array || tensor.cpuData instanceof BigUint64Array) {
                          arrayData = Array.from(tensor.cpuData).map(x => Number(x));
                        } else {
                          arrayData = Array.from(tensor.cpuData);
                        }
                        console.log(`[GrammarCorrector] ✅ Extracted ${arrayData.length} elements from ${name}.cpuData`);
                      } else if (tensor.data) {
                        if (tensor.data instanceof BigInt64Array || tensor.data instanceof BigUint64Array) {
                          arrayData = Array.from(tensor.data).map(x => Number(x));
                        } else {
                          arrayData = Array.from(tensor.data);
                        }
                        console.log(`[GrammarCorrector] ✅ Extracted ${arrayData.length} elements from ${name}.data`);
                      } else {
                        console.warn(`[GrammarCorrector] ⚠️ ${name} has no cpuData or data, cannot fix`);
                        return tensor;
                      }
                      
                      if (!arrayData || arrayData.length === 0) {
                        console.warn(`[GrammarCorrector] ⚠️ ${name} has no data to extract, returning original`);
                        return tensor;
                      }
                      
                      // Ensure dims match data length
                      const totalElements = arrayData.length;
                      const dimsProduct = dims.reduce((a, b) => a * b, 1);
                      const finalDims = dimsProduct !== totalElements ? [1, totalElements] : dims;
                      
                      // Create BigInt64Array for int64
                      let typedArray;
                      if (type === 'int64') {
                        const bigIntData = arrayData.map(x => BigInt(x));
                        typedArray = new BigInt64Array(bigIntData);
                        console.log(`[GrammarCorrector] ✅ Created BigInt64Array for ${name}, length:`, typedArray.length);
                      } else {
                        typedArray = new (tensor.cpuData?.constructor || Int32Array)(arrayData);
                        console.log(`[GrammarCorrector] ✅ Created ${typedArray.constructor.name} for ${name}`);
                      }
                      
                      const fixedTensor = new Tensor(type, typedArray, finalDims);
                      // CRITICAL: location is a getter property, only set dataLocation
                      fixedTensor.dataLocation = tensor.dataLocation || 'cpu';
                      
                      // CRITICAL: Also ensure data property is explicitly set
                      fixedTensor.data = typedArray;
                      
                      console.log(`[GrammarCorrector] ✅ Fixed ${name} - dims:`, fixedTensor.dims, 'has data:', !!fixedTensor.data, 'location:', fixedTensor.location);
                      return fixedTensor;
                    };
                    
                    // Fix input_ids
                    const fixedInputIds = fixTensor(inputIdsTensor, 'input_ids');
                    
                    // Fix attention_mask if it exists
                    let fixedAttentionMask = null;
                    if (inputs && inputs.attention_mask) {
                      fixedAttentionMask = fixTensor(inputs.attention_mask, 'attention_mask');
                        // Double-check it was fixed
                        if (fixedAttentionMask instanceof Tensor) {
                          if (!fixedAttentionMask.dataLocation) {
                            fixedAttentionMask.dataLocation = 'cpu';
                            console.log('[GrammarCorrector] 🔧 Force-set attention_mask.dataLocation = "cpu"');
                          }
                        if (!fixedAttentionMask.data) {
                          console.warn('[GrammarCorrector] ⚠️ attention_mask still has no data after fix!');
                        }
                      }
                    } else {
                      console.warn('[GrammarCorrector] ⚠️ No attention_mask found in inputs');
                    }
                    
                    // CRITICAL: model.generate() may access inputs.attention_mask directly from the tokenizer
                    // We need to replace the original inputs object with our fixed tensors
                    // Create a new inputs object with fixed tensors
                    const fixedInputs = {
                      input_ids: fixedInputIds,
                    };
                    
                    // Always include attention_mask if we have it
                    if (fixedAttentionMask) {
                      fixedInputs.attention_mask = fixedAttentionMask;
                      console.log('[GrammarCorrector] ✅ Added fixed attention_mask to fixedInputs');
                    }
                    
                    // Replace the original inputs object to ensure model.generate() uses fixed tensors
                    // Delete old properties first, then assign new ones
                    if ('input_ids' in inputs) {
                      delete inputs.input_ids;
                    }
                    if ('attention_mask' in inputs) {
                      delete inputs.attention_mask;
                    }
                    
                    // Assign fixed tensors
                    inputs.input_ids = fixedInputIds;
                    if (fixedAttentionMask) {
                      inputs.attention_mask = fixedAttentionMask;
                      console.log('[GrammarCorrector] ✅ Replaced inputs.attention_mask with fixed version');
                    }
                    
                    console.log('[GrammarCorrector] ✅ Updated inputs object with fixed tensors');
                    
                    const generateOptions = {
                      max_new_tokens: options.max_new_tokens || 256,
                      do_sample: false,
                    };
                    
                    // Apply the Tensor._subarray patch before generation
                    await patchTensorSubarray();
                    
                    // CRITICAL: Pass both input_ids AND attention_mask
                    // model.generate accepts inputs_attention_mask as 4th argument options
                    const outputs = await model.generate(
                      fixedInputIds,
                      generateOptions,
                      null, // logits_processor
                      { inputs_attention_mask: fixedAttentionMask } // options
                    );
                    console.log('[GrammarCorrector] ✅ model.generate() completed successfully');
                    
                    // Handle different output formats from model.generate
                    // model.generate typically returns the token IDs directly or wrapped in an object
                    let outputIds = null;
                    
                    try {
                      // Try to extract token IDs from various possible formats
                      if (Array.isArray(outputs)) {
                        // If it's an array, take the first element (sequence)
                        outputIds = outputs[0];
                        // If first element is also an array or has data, extract further
                        if (outputIds && typeof outputIds === 'object' && outputIds.data) {
                          outputIds = outputIds.data;
                        }
                      } else if (outputs && typeof outputs === 'object') {
                        // Check for common property names
                        if (outputs.sequences !== undefined && outputs.sequences !== null) {
                          const seq = Array.isArray(outputs.sequences) ? outputs.sequences[0] : outputs.sequences;
                          if (seq && seq.data !== undefined) {
                            outputIds = seq.data;
                          } else if (seq) {
                            outputIds = seq;
                          }
                        } else if (outputs.input_ids !== undefined && outputs.input_ids !== null) {
                          const ids = outputs.input_ids;
                          if (ids.data !== undefined) {
                            outputIds = ids.data;
                          } else {
                            outputIds = ids;
                          }
                        } else if (outputs[0] !== undefined) {
                          outputIds = outputs[0];
                        } else if (outputs.data !== undefined) {
                          outputIds = outputs.data;
                        } else {
                          // Use the object itself - might be a Tensor
                          outputIds = outputs;
                        }
                      } else {
                        outputIds = outputs;
                      }
                      
                      // Convert to plain array if needed to avoid 'subarray' errors
                      if (outputIds && typeof outputIds === 'object' && outputIds !== null) {
                        // If it's a TypedArray or similar, convert to regular array
                        if (!Array.isArray(outputIds)) {
                          // Check if it has length property (TypedArray-like)
                          if ('length' in outputIds && typeof outputIds.length === 'number') {
                            try {
                              // Convert TypedArray to regular array
                              outputIds = Array.from(outputIds);
                            } catch (convertError) {
                              // If conversion fails, try using subarray (but safely)
                              if ('subarray' in outputIds && typeof outputIds.subarray === 'function') {
                                outputIds = outputIds.subarray(0);
                              }
                            }
                          }
                        }
                      }
                      
                      if (!outputIds || (Array.isArray(outputIds) && outputIds.length === 0)) {
                        throw new Error('Could not extract valid token IDs from model.generate output');
                      }
                      
                      // tokenizer.decode expects an array or tensor-like object
                      // Pass it directly - tokenizer should handle the conversion
                      const decoded = await tokenizer.decode(outputIds, { skip_special_tokens: true });
                  return [{ generated_text: decoded }];
                    } catch (decodeError) {
                      // If decode fails, log the error and the output format for debugging
                      console.error('[GrammarCorrector] Decode error:', decodeError.message);
                      console.error('[GrammarCorrector] Output type:', typeof outputs);
                      console.error('[GrammarCorrector] Output isArray:', Array.isArray(outputs));
                      if (outputs && typeof outputs === 'object') {
                        console.error('[GrammarCorrector] Output keys:', Object.keys(outputs));
                      }
                      throw decodeError;
                    }
                  } catch (error) {
                    console.error('[GrammarCorrector] Pipeline wrapper error:', error.message);
                    console.error('[GrammarCorrector] Error stack:', error.stack);
                    throw error;
                  }
                };
                
                console.log(`[GrammarCorrector] ✅ Direct model loaded: ${directModelName}`);
                this.status = 'ready';
                this.useAPI = false;
            }
          } catch (firstError) {
            // If Xenova version fails, try original with different config
            if (modelToTry === 'Xenova/grammar-synthesis-small') {
              console.warn(`[GrammarCorrector] ⚠️ Xenova version failed: ${firstError.message}`);
              console.log(`[GrammarCorrector] 🔄 Trying original model: ${this.originalModelName}...`);
              modelToTry = this.originalModelName;
              
              // Retry with original model
              try {
                this.pipeline = await pipeline(
                  'text2text-generation',
                  modelToTry,
                  {
                    quantized: false,
                  }
                );
                console.log(`[GrammarCorrector] ✅ Original model loaded via pipeline: ${modelToTry}`);
                this.status = 'ready';
                this.useAPI = false;
              } catch (pipelineError2) {
                  // Last resort: try direct loading with Xenova model
                console.log(`[GrammarCorrector] 🔄 Pipeline failed, trying direct loading...`);
                  const fallbackModelName = 'Xenova/grammar-synthesis-small';
                  console.log(`[GrammarCorrector] Using ${fallbackModelName} for fallback direct loading`);
                  const tokenizer = await Promise.race([
                    AutoTokenizer.from_pretrained(fallbackModelName),
                    new Promise((_, reject) => 
                      setTimeout(() => reject(new Error('Tokenizer load timeout after 60s')), 60000)
                    )
                  ]);
                  const model = await Promise.race([
                    AutoModelForSeq2SeqLM.from_pretrained(fallbackModelName, {
                      quantized: true, // Use quantized for faster loading
                    }),
                    new Promise((_, reject) => 
                      setTimeout(() => reject(new Error('Model load timeout after 120s')), 120000)
                    )
                  ]);
                
                this.pipeline = async (text, options = {}) => {
                    try {
                      // Tokenize with proper options for @xenova/transformers
                      // Note: @xenova/transformers uses different options than Python transformers
                  const inputs = await tokenizer(text);
                      
                      // Validate inputs structure
                      if (!inputs) {
                        throw new Error('Tokenizer returned undefined');
                      }
                      
                      // Handle different tokenizer output formats from @xenova/transformers
                      let inputIds;
                      if (inputs && inputs.input_ids) {
                        const inputIdsValue = inputs.input_ids;
                        // Check if it's a Tensor object with data property
                        if (inputIdsValue.data !== undefined) {
                          inputIds = inputIdsValue.data;
                        } else if (inputIdsValue && typeof inputIdsValue === 'object' && inputIdsValue !== null && 'subarray' in inputIdsValue) {
                          // TypedArray with subarray method
                          inputIds = inputIdsValue;
                        } else if (Array.isArray(inputIdsValue)) {
                          inputIds = inputIdsValue;
                        } else {
                          inputIds = inputIdsValue;
                        }
                      } else if (Array.isArray(inputs)) {
                        inputIds = inputs[0] || inputs;
                      } else if (inputs && inputs.data) {
                        inputIds = inputs.data;
                      } else {
                        inputIds = inputs;
                      }
                      
                      if (!inputIds) {
                        throw new Error('Could not extract input_ids from tokenizer output');
                      }
                      
                      // Generate with model
                      // Use minimal options to avoid seq2seqStartBeams bug
                      // The bug occurs when the library tries to initialize beam search with undefined tensor data
                      const generateOptions = {
                    max_new_tokens: options.max_new_tokens || 256,
                        num_beams: 1, // Force single beam to avoid beam search code path
                        do_sample: false, // Force greedy decoding
                        // Don't pass early_stopping or temperature as they might trigger the buggy code path
                      };
                      
                      const outputs = await model.generate(inputIds, generateOptions);
                      
                      // Handle different output formats from model.generate
                      // model.generate typically returns the token IDs directly or wrapped in an object
                      let outputIds = null;
                      
                      try {
                        // Try to extract token IDs from various possible formats
                        if (Array.isArray(outputs)) {
                          // If it's an array, take the first element (sequence)
                          outputIds = outputs[0];
                          // If first element is also an array or has data, extract further
                          if (outputIds && typeof outputIds === 'object' && outputIds.data) {
                            outputIds = outputIds.data;
                          }
                        } else if (outputs && typeof outputs === 'object') {
                          // Check for common property names
                          if (outputs.sequences !== undefined && outputs.sequences !== null) {
                            const seq = Array.isArray(outputs.sequences) ? outputs.sequences[0] : outputs.sequences;
                            if (seq && seq.data !== undefined) {
                              outputIds = seq.data;
                            } else if (seq) {
                              outputIds = seq;
                            }
                          } else if (outputs.input_ids !== undefined && outputs.input_ids !== null) {
                            const ids = outputs.input_ids;
                            if (ids.data !== undefined) {
                              outputIds = ids.data;
                            } else {
                              outputIds = ids;
                            }
                          } else if (outputs[0] !== undefined) {
                            outputIds = outputs[0];
                          } else if (outputs.data !== undefined) {
                            outputIds = outputs.data;
                          } else {
                            // Use the object itself - might be a Tensor
                            outputIds = outputs;
                          }
                        } else {
                          outputIds = outputs;
                        }
                        
                        // Convert to plain array if needed to avoid 'subarray' errors
                        if (outputIds && typeof outputIds === 'object' && outputIds !== null) {
                          // If it's a TypedArray or similar, convert to regular array
                          if (!Array.isArray(outputIds)) {
                            // Check if it has length property (TypedArray-like)
                            if ('length' in outputIds && typeof outputIds.length === 'number') {
                              try {
                                // Convert TypedArray to regular array
                                outputIds = Array.from(outputIds);
                              } catch (convertError) {
                                // If conversion fails, try using subarray (but safely)
                                if ('subarray' in outputIds && typeof outputIds.subarray === 'function') {
                                  outputIds = outputIds.subarray(0);
                                }
                              }
                            }
                          }
                        }
                        
                        if (!outputIds || (Array.isArray(outputIds) && outputIds.length === 0)) {
                          throw new Error('Could not extract valid token IDs from model.generate output');
                        }
                        
                        // tokenizer.decode expects an array or tensor-like object
                        // Pass it directly - tokenizer should handle the conversion
                        const decoded = await tokenizer.decode(outputIds, { skip_special_tokens: true });
                  return [{ generated_text: decoded }];
                      } catch (decodeError) {
                        // If decode fails, log the error and the output format for debugging
                        console.error('[GrammarCorrector] Decode error:', decodeError.message);
                        console.error('[GrammarCorrector] Output type:', typeof outputs);
                        console.error('[GrammarCorrector] Output isArray:', Array.isArray(outputs));
                        if (outputs && typeof outputs === 'object') {
                          console.error('[GrammarCorrector] Output keys:', Object.keys(outputs));
                        }
                        throw decodeError;
                      }
                    } catch (error) {
                      console.error('[GrammarCorrector] Pipeline wrapper error:', error.message);
                      console.error('[GrammarCorrector] Error stack:', error.stack);
                      throw error;
                    }
                };
                
                console.log(`[GrammarCorrector] ✅ Original model loaded directly: ${modelToTry}`);
                this.status = 'ready';
                this.useAPI = false;
              }
            } else {
              throw firstError;
            }
          }
        } catch (localError) {
          console.warn(`[GrammarCorrector] ⚠️ Local model failed: ${localError.message}`);
          console.log('[GrammarCorrector] 🔄 Falling back to HuggingFace Inference API...');
          this.status = 'loading';
          console.log('[GrammarCorrector] 📋 Status: LOADING - Testing API connection...');
          
          // Test API connection
          try {
            const testResponse = await fetch(this.apiUrl, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                ...(this.hfToken && { 'Authorization': `Bearer ${this.hfToken}` })
              },
              body: JSON.stringify({ inputs: 'test' }),
              signal: AbortSignal.timeout(10000)
            });
            
            if (testResponse.ok || testResponse.status === 503) {
              console.log(`[GrammarCorrector] ✅ Using HuggingFace Inference API for ${this.originalModelName}`);
              console.log('[GrammarCorrector] 📋 Status: READY - Using API mode');
              this.useAPI = true;
              this.pipeline = true; // Mark as initialized
              this.status = 'ready';
              const elapsed = Date.now() - this.initStartTime;
              console.log(`[GrammarCorrector] ⏱️ API fallback ready in ${(elapsed / 1000).toFixed(1)}s`);
            } else {
              throw new Error(`API test failed: ${testResponse.statusText}`);
            }
          } catch (apiError) {
            console.error('[GrammarCorrector] ❌ API fallback also failed:', apiError.message);
            this.status = 'failed';
            this.enabled = false;
            throw new Error(`Both local model and API failed. Local: ${localError.message}, API: ${apiError.message}`);
          }
        }
        
        this.initializing = false;
        clearInterval(statusInterval); // Stop status updates
        if (this.status !== 'failed') {
          const totalElapsed = Date.now() - this.initStartTime;
          console.log('[GrammarCorrector] ✅ Status: READY - Grammar correction active');
          console.log(`[GrammarCorrector] ⏱️ Total initialization time: ${(totalElapsed / 1000).toFixed(1)}s`);
        }
      } catch (error) {
        clearInterval(statusInterval); // Stop status updates on error
        console.error('[GrammarCorrector] ❌ Failed to initialize:', error);
        this.status = 'failed';
        this.enabled = false;
        this.initializing = false;
        throw error;
      }
    })();

    return this.initPromise;
  }

  /**
   * Correct grammar in text using the model
   * @param {string} text - Text to correct
   * @param {string} language - Language code (mostly for future use)
   * @returns {Promise<Object>} { corrected: string, matches: number }
   */
  async correct(text, language = null) {
    if (!this.enabled || !text || text.trim().length === 0) {
      return {
        corrected: text || '',
        matches: 0
      };
    }

    try {
      // Lazy initialization (non-blocking)
      if (!this.pipeline && !this.initializing) {
        // Start initialization but don't wait for it
        console.log('[GrammarCorrector] 🚀 Model not initialized, starting background initialization...');
        this.init().catch(err => {
          console.warn('[GrammarCorrector] Background init failed:', err.message);
        });
      }
      
      // If pipeline has the bug, switch to direct loading
      if (this._pipelineHasBug && !this._switchingToDirect) {
        this._switchingToDirect = true;
        console.log('[GrammarCorrector] 🔄 Pipeline has bug, switching to direct model loading...');
        // Trigger re-initialization with direct loading
        this.pipeline = null;
        this.status = 'loading';
        this.init().catch(err => {
          console.warn('[GrammarCorrector] Direct loading init failed:', err.message);
        });
      }
      
      // If model isn't ready, return original text immediately - don't wait
      if (!this.pipeline || this.initializing) {
        // Log status periodically (every 5 seconds) to show progress
        if (this.status === 'downloading' || this.status === 'loading') {
          const elapsed = this.initStartTime ? Math.floor((Date.now() - this.initStartTime) / 1000) : 0;
          if (!this._lastStatusLog || Date.now() - this._lastStatusLog > 5000) {
            console.log(`[GrammarCorrector] ⏳ Status: ${this.status.toUpperCase()} (${elapsed}s elapsed) - Using original text until ready`);
            this._lastStatusLog = Date.now();
          }
        } else if (this.status === 'not_initialized') {
          if (!this._lastStatusLog || Date.now() - this._lastStatusLog > 5000) {
            console.log('[GrammarCorrector] ⏳ Status: NOT_INITIALIZED - Initialization starting...');
            this._lastStatusLog = Date.now();
          }
        }
        // Model not ready - return original text without blocking
        return {
          corrected: text,
          matches: 0
        };
      }

      const original = text.trim();
      let corrected = original;
      
      if (this.useAPI) {
        // Use HuggingFace Inference API
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        
        try {
          const response = await fetch(this.apiUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(this.hfToken && { 'Authorization': `Bearer ${this.hfToken}` })
            },
            body: JSON.stringify({ inputs: original }),
            signal: controller.signal
          }).finally(() => clearTimeout(timeout));
          
          if (!response.ok) {
            if (response.status === 503) {
              console.warn('[GrammarCorrector] ⚠️ Model loading, using original text');
              return {
                corrected: original,
                matches: 0
              };
            } else {
              throw new Error(`API error: ${response.statusText}`);
            }
          }
          
          const result = await response.json();
          
          // API returns: [{ generated_text: "..." }] or string
          if (Array.isArray(result) && result.length > 0) {
            const firstResult = result[0];
            if (typeof firstResult === 'string') {
              corrected = firstResult;
            } else if (firstResult && typeof firstResult === 'object') {
              corrected = firstResult.generated_text || firstResult.text || original;
            }
          } else if (typeof result === 'string') {
            corrected = result;
          } else if (result && typeof result === 'object') {
            corrected = result.generated_text || result.text || result[0]?.generated_text || original;
          }
          
          // Log successful API correction (first time only to show it's working)
          if (corrected !== original && !this._apiWorkingLogged) {
            console.log('[GrammarCorrector] ✅ Grammar correction via API is working');
            this._apiWorkingLogged = true;
          }
        } catch (apiError) {
          console.warn('[GrammarCorrector] API request failed:', apiError.message);
          // Fallback to original text
          corrected = original;
        }
      } else {
        // Use local pipeline
        // Generate corrected text
        // The model takes potentially grammatically incorrect text
        // and outputs the corrected version
        let result;
        try {
          // Try with minimal options first to avoid beam search issues
          // Pass as string, not pre-tokenized, and use greedy decoding
          result = await this.pipeline(original, {
            max_new_tokens: 256,
            num_beams: 1,
            // Try without early_stopping as it might trigger beam search code path
          do_sample: false,
          });
        } catch (pipelineCallError) {
          // Log FULL error details before handling
          console.error('[GrammarCorrector] ===== PIPELINE CALL ERROR DETAILS =====');
          console.error('[GrammarCorrector] Error message:', pipelineCallError.message);
          console.error('[GrammarCorrector] Error name:', pipelineCallError.name);
          console.error('[GrammarCorrector] Error stack:', pipelineCallError.stack);
          if (pipelineCallError.cause) {
            console.error('[GrammarCorrector] Error cause:', pipelineCallError.cause);
          }
          try {
            console.error('[GrammarCorrector] Full error object:', JSON.stringify(pipelineCallError, Object.getOwnPropertyNames(pipelineCallError)));
          } catch (e) {
            console.error('[GrammarCorrector] Could not stringify error:', e.message);
          }
          console.error('[GrammarCorrector] ============================================');
          
          // Catch errors from the pipeline call (e.g., 'subarray' errors from @xenova/transformers)
          if (pipelineCallError.message && pipelineCallError.message.includes('subarray')) {
            console.warn('[GrammarCorrector] Pipeline internal error (subarray issue), falling back to original text');
            // Fall back to original text
            return {
              corrected: original,
              matches: 0
            };
          }
          // Re-throw other errors
          throw pipelineCallError;
        }

        // Extract corrected text from result
        // Result format from @xenova/transformers: [{ generated_text: "..." }]
        if (Array.isArray(result)) {
          if (result.length > 0) {
            // Handle array of results
            const firstResult = result[0];
            if (typeof firstResult === 'string') {
              corrected = firstResult;
            } else if (firstResult && typeof firstResult === 'object') {
              corrected = firstResult.generated_text || firstResult.text || original;
            }
          }
        } else if (typeof result === 'string') {
          corrected = result;
        } else if (result && typeof result === 'object') {
          // Handle object result
          corrected = result.generated_text || result.text || result.output || original;
        }
        
        // Log successful local correction (first time only to show it's working)
        if (corrected !== original && !this._localWorkingLogged) {
          console.log('[GrammarCorrector] ✅ Grammar correction via local model is working');
          this._localWorkingLogged = true;
        }
      }

      // Ensure we have valid text
      if (!corrected || corrected.trim().length === 0) {
        corrected = original;
      }

      // Count approximate changes (simple heuristic)
      const matches = corrected.toLowerCase() !== original.toLowerCase() ? 1 : 0;

      return {
        corrected: corrected.trim(),
        matches
      };
    } catch (error) {
      // Don't log errors for every failed correction - only critical ones
      if (!error.message.includes('timeout') && !error.message.includes('not available')) {
        console.warn('[GrammarCorrector] Error correcting text:', error.message);
      }
      // Always fallback to original text on error - never block the flow
      return {
        corrected: text,
        matches: 0
      };
    }
  }

  /**
   * Check text for issues (placeholder for now)
   * @param {string} text - Text to check
   * @returns {Promise<Array>} List of detected issues
   */
  async check(text) {
    // Simple implementation - compare original vs corrected
    const result = await this.correct(text);
    const issues = [];
    
    if (result.matches > 0 && result.corrected !== text) {
      issues.push({
        original: text,
        corrected: result.corrected,
        confidence: 'medium'
      });
    }
    
    return issues;
  }

  /**
   * Clean up resources
   */
  dispose() {
    this.pipeline = null;
    this.enabled = false;
  }
}

// Singleton instance
let correctorInstance = null;

export function getGrammarCorrectorModel() {
  if (!correctorInstance) {
    correctorInstance = new GrammarCorrectorModel();
  }
  return correctorInstance;
}

export default GrammarCorrectorModel;

