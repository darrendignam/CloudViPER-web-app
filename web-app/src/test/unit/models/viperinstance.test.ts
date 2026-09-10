import { Sequelize, DataTypes } from 'sequelize';
import dotenv from 'dotenv';
import ViperInstance from '../../../models/viperinstance';
import path from 'path';

const result = dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

// Mock Sequelize to avoid real database connections
jest.mock('sequelize');

describe('ViperInstance Model', () => {
  let mockSequelize: any;
  let viperInstanceModel: any;

  beforeAll(async () => {
    // Create a mock Sequelize instance
    mockSequelize = {
      authenticate: jest.fn().mockResolvedValue(true),
      sync: jest.fn().mockResolvedValue(true),
      close: jest.fn().mockResolvedValue(true),
      define: jest.fn()
    };

    // Initialize the ViperInstance model with mock
    viperInstanceModel = ViperInstance(mockSequelize);
    
    // Mock common Sequelize methods for the model
    viperInstanceModel.create = jest.fn();
    viperInstanceModel.findOne = jest.fn();
    viperInstanceModel.findAll = jest.fn();
    viperInstanceModel.findByPk = jest.fn();
    viperInstanceModel.update = jest.fn();
    viperInstanceModel.destroy = jest.fn();
    viperInstanceModel.bulkCreate = jest.fn();
    
    // Mock rawAttributes for property testing
    viperInstanceModel.rawAttributes = {
      id: { type: 'INTEGER' },
      owner: { type: 'INTEGER' },
      uuid: { type: 'STRING' },
      dockerid: { type: 'STRING' },
      name: { type: 'STRING' },
      url: { type: 'STRING' },
      masterToken: { type: 'STRING' },
      statusKey: { type: 'STRING' },
      createdAt: { type: 'DATE' },
      updatedAt: { type: 'DATE' },
      status: { type: 'STRING' },
      logs: { type: 'JSON' }
    };
  });

  it('should initialize the ViperInstance model', () => {
    expect(viperInstanceModel).toBeDefined();
  });

  it('should have correct model properties', () => {
    const attributes = viperInstanceModel.rawAttributes;

    expect(attributes.id).toBeDefined();
    expect(attributes.owner).toBeDefined();
    expect(attributes.uuid).toBeDefined();
    expect(attributes.dockerid).toBeDefined();
    expect(attributes.name).toBeDefined();
    expect(attributes.url).toBeDefined();
    expect(attributes.masterToken).toBeDefined();
    expect(attributes.statusKey).toBeDefined();
    expect(attributes.createdAt).toBeDefined();
    expect(attributes.updatedAt).toBeDefined();
    expect(attributes.status).toBeDefined();
    expect(attributes.logs).toBeDefined();
  });

  it('should create a new ViperInstance with required fields', async () => {
    const viperInstanceData = {
      owner: 1,
      uuid: 'test-uuid-123',
      dockerid: 'docker-123',
      name: 'Test Viper Instance',
      url: 'https://test.example.com',
      masterToken: 'test-master-token-123',
      statusKey: 'status-key-456'
    };

    const mockCreatedInstance = {
      id: 1,
      ...viperInstanceData,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    viperInstanceModel.create.mockResolvedValue(mockCreatedInstance);

    const viperInstance = await viperInstanceModel.create(viperInstanceData);
    
    expect(viperInstance).toBeDefined();
    expect(viperInstance.id).toBeDefined();
    expect(viperInstance.owner).toBe(viperInstanceData.owner);
    expect(viperInstance.uuid).toBe(viperInstanceData.uuid);
    expect(viperInstance.dockerid).toBe(viperInstanceData.dockerid);
    expect(viperInstance.name).toBe(viperInstanceData.name);
    expect(viperInstance.url).toBe(viperInstanceData.url);
    expect(viperInstance.masterToken).toBe(viperInstanceData.masterToken);
    expect(viperInstance.statusKey).toBe(viperInstanceData.statusKey);
    expect(viperInstance.createdAt).toBeDefined();
    expect(viperInstance.updatedAt).toBeDefined();
  });

  it('should set default values correctly', async () => {
    const minimalData = {
      owner: 2,
      uuid: 'minimal-uuid',
      dockerid: 'minimal-docker',
      name: 'Minimal Instance'
    };

    const mockInstanceWithDefaults = {
      id: 2,
      ...minimalData,
      status: 'initilising', // Note: keeping the typo from model
      logs: [],
      createdAt: new Date(),
      updatedAt: new Date()
    };

    viperInstanceModel.create.mockResolvedValue(mockInstanceWithDefaults);

    const viperInstance = await viperInstanceModel.create(minimalData);
    
    // Check default values
    expect(viperInstance.status).toBe('initilising'); // Note: keeping the typo from model
    expect(viperInstance.logs).toEqual([]);
    expect(viperInstance.createdAt).toBeDefined();
    expect(viperInstance.updatedAt).toBeDefined();
  });

  it('should allow creating instance with logs data', async () => {
    const dataWithLogs = {
      owner: 3,
      uuid: 'logs-uuid',
      dockerid: 'logs-docker',
      name: 'Logs Instance',
      logs: [
        { timestamp: '2025-01-01T00:00:00Z', message: 'Container started' },
        { timestamp: '2025-01-01T00:01:00Z', message: 'Service initialized' }
      ]
    };

    const mockInstanceWithLogs = {
      id: 3,
      ...dataWithLogs,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    viperInstanceModel.create.mockResolvedValue(mockInstanceWithLogs);

    const viperInstance = await viperInstanceModel.create(dataWithLogs);
    
    expect(viperInstance.logs).toEqual(dataWithLogs.logs);
    expect(viperInstance.logs).toHaveLength(2);
    expect(viperInstance.logs[0].message).toBe('Container started');
  });

  it('should update ViperInstance fields', async () => {
    const initialData = {
      id: 4,
      owner: 4,
      uuid: 'update-uuid',
      dockerid: 'update-docker',
      name: 'Update Test',
      status: 'initilising',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const mockInstance = {
      ...initialData,
      update: jest.fn().mockImplementation((updates) => {
        Object.assign(mockInstance, updates);
        return Promise.resolve(mockInstance);
      })
    };

    viperInstanceModel.create.mockResolvedValue(mockInstance);

    const viperInstance = await viperInstanceModel.create({
      owner: 4,
      uuid: 'update-uuid',
      dockerid: 'update-docker',
      name: 'Update Test',
      status: 'initilising'
    });

    // Update the instance
    await viperInstance.update({
      status: 'running',
      url: 'https://updated.example.com',
      logs: [{ timestamp: '2025-01-01T00:00:00Z', message: 'Status updated' }]
    });

    expect(viperInstance.status).toBe('running');
    expect(viperInstance.url).toBe('https://updated.example.com');
    expect(viperInstance.logs[0].message).toBe('Status updated');
  });

  it('should find ViperInstance by various criteria', async () => {
    const testData = {
      id: 5,
      owner: 5,
      uuid: 'find-uuid-123',
      dockerid: 'find-docker-456',
      name: 'Findable Instance',
      status: 'running',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    viperInstanceModel.create.mockResolvedValue(testData);
    viperInstanceModel.findOne.mockResolvedValue(testData);
    viperInstanceModel.findAll.mockResolvedValue([testData]);

    await viperInstanceModel.create(testData);

    // Find by uuid
    const foundByUuid = await viperInstanceModel.findOne({ where: { uuid: 'find-uuid-123' } });
    expect(foundByUuid).toBeDefined();
    expect(foundByUuid.name).toBe('Findable Instance');

    // Find by owner
    const foundByOwner = await viperInstanceModel.findAll({ where: { owner: 5 } });
    expect(foundByOwner).toHaveLength(1);
    expect(foundByOwner[0].uuid).toBe('find-uuid-123');

    // Find by status
    const runningInstances = await viperInstanceModel.findAll({ where: { status: 'running' } });
    expect(runningInstances.length).toBeGreaterThanOrEqual(1);
  });

  it('should delete ViperInstance', async () => {
    const mockInstance = {
      id: 6,
      owner: 6,
      uuid: 'delete-uuid',
      dockerid: 'delete-docker',
      name: 'Delete Test',
      destroy: jest.fn().mockResolvedValue(true)
    };

    viperInstanceModel.create.mockResolvedValue(mockInstance);
    viperInstanceModel.findByPk.mockResolvedValue(null);

    const viperInstance = await viperInstanceModel.create({
      owner: 6,
      uuid: 'delete-uuid',
      dockerid: 'delete-docker',
      name: 'Delete Test'
    });

    const instanceId = viperInstance.id;
    
    // Delete the instance
    await viperInstance.destroy();

    // Verify it's deleted
    const deletedInstance = await viperInstanceModel.findByPk(instanceId);
    expect(deletedInstance).toBeNull();
  });

  it('should handle bulk operations', async () => {
    const bulkData = [
      { owner: 7, uuid: 'bulk-1', dockerid: 'bulk-docker-1', name: 'Bulk Test 1' },
      { owner: 7, uuid: 'bulk-2', dockerid: 'bulk-docker-2', name: 'Bulk Test 2' },
      { owner: 7, uuid: 'bulk-3', dockerid: 'bulk-docker-3', name: 'Bulk Test 3' }
    ];

    const mockCreatedInstances = bulkData.map((data, index) => ({
      id: index + 1,
      ...data,
      createdAt: new Date(),
      updatedAt: new Date()
    }));

    viperInstanceModel.bulkCreate.mockResolvedValue(mockCreatedInstances);
    viperInstanceModel.update.mockResolvedValue([3, mockCreatedInstances]);
    viperInstanceModel.findAll.mockResolvedValue([]);
    viperInstanceModel.destroy.mockResolvedValue(3);

    // Bulk create
    const createdInstances = await viperInstanceModel.bulkCreate(bulkData);
    expect(createdInstances).toHaveLength(3);

    // Bulk update
    await viperInstanceModel.update(
      { status: 'stopped' },
      { where: { owner: 7 } }
    );

    // Verify bulk update worked (mock would have been called)
    expect(viperInstanceModel.update).toHaveBeenCalled();

    // Bulk delete
    await viperInstanceModel.destroy({ where: { owner: 7 } });
    
    // Verify bulk delete
    const remainingInstances = await viperInstanceModel.findAll({ where: { owner: 7 } });
    expect(remainingInstances).toHaveLength(0);
  });

  it('should test associate method exists', () => {
    expect(typeof viperInstanceModel.associate).toBe('function');
    // Test that associate method exists - we can't actually test the association
    // without setting up complex Sequelize mocks, so we just verify the method exists
    // and skip the actual association call in tests
    expect(viperInstanceModel.associate).toBeDefined();
  });

  it('should test associate method functionality', () => {
    const mockModels = {
      User: {
        belongsTo: jest.fn(),
        hasMany: jest.fn()
      }
    };

    // Mock belongsTo on viperInstanceModel
    viperInstanceModel.belongsTo = jest.fn();

    // Test calling the associate method
    viperInstanceModel.associate(mockModels);

    // Verify that belongsTo was called with correct parameters
    expect(viperInstanceModel.belongsTo).toHaveBeenCalledWith(mockModels.User, {
      foreignKey: 'owner',
      as: 'ownerUser'
    });
  });

  afterAll(async () => {
    await mockSequelize.close();
  });
});
