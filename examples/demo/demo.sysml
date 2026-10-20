package VehicleModel {

    import ScalarValues::*;

    part vehicle : Vehicle;

    part def Vehicle {
        part chassis : Chassis;
        part wheels : Wheels;
        attribute totalMass : Real;
    }

    part def Chassis {
        attribute frameMass : Real = 120.0;
    }

    part def Wheels {
        part wheel[4] : Wheel;
    }

    part def Wheel {
        attribute radius : Real = 0.3;
    }

    attribute def Mass {
        attribute massValue : Real;
    }

    constraint def SpeedLimit {
        attribute maxSpeed : Real;
        attribute limit : Real;
        maxSpeed <= limit
    }

    requirement def VehicleRequirement {
        attribute reqId : String = 'VEH-001';
        attribute text : String = 'The vehicle mass shall not exceed 2000 kg.';
    }

    verification def MassVerification {
        subject vehicle : Vehicle;
        objective {
            verify VehicleRequirement;
        }
    }

    action def CheckMass {
        in item massInput : Mass;
        attribute limit : Real = 2000.0;
    }

    constraint massBudget {
        CheckMass::limit <= 2000.0
    }

    state def VehicleState {
        entry; then stopped;
        state stopped;
        state moving {
            do action accelerate;
        }
        transition start
            first stopped
            accept startSignal
            then moving;
    }

    action accelerate;

    allocation def MassAllocation {
        allocate CheckMass to VehicleRequirement;
    }
}
